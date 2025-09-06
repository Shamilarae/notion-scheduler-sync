const { Client } = require('@notionhq/client');

// Initialize Notion client
let notion;
try {
    notion = new Client({ auth: process.env.NOTION_TOKEN });
} catch (error) {
    console.error('Failed to initialize Notion client:', error.message);
    throw new Error('NOTION_TOKEN is required');
}

// Database IDs - EXACT matches from your Notion
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar setup
let calendar = null;
let calendarEnabled = false;

try {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        const { google } = require('googleapis');
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: [
                'https://www.googleapis.com/auth/calendar.readonly',
                'https://www.googleapis.com/auth/calendar'
            ],
        });

        calendar = google.calendar({ version: 'v3', auth });
        calendarEnabled = true;
        console.log('Google Calendar integration enabled');
    } else {
        console.log('Google Calendar disabled: Missing credentials');
    }
} catch (error) {
    console.error('Google Calendar initialization failed:', error.message);
    console.log('Continuing with Notion-only scheduling');
}

// Calendar routing
const WORK_SITE_CALENDAR_ID = 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com';

// Timezone conversion functions
function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        const pacificDateTime = `${pacificDateStr}T${pacificTimeStr}:00`;
        const tempDate = new Date(pacificDateTime);
        
        const pacificDate = new Date(tempDate.toLocaleString("en-US", {timeZone: "America/Vancouver"}));
        const utcDate = new Date(tempDate.toLocaleString("en-US", {timeZone: "UTC"}));
        const offset = utcDate.getTime() - pacificDate.getTime();
        
        return new Date(tempDate.getTime() + offset).toISOString();
    } catch (error) {
        console.error('Error in pacificTimeToUTC:', error.message);
        return new Date(`${pacificDateStr}T${pacificTimeStr}:00.000Z`).toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const utcDate = new Date(utcDateStr);
        
        const pacificTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Vancouver',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(utcDate);
        
        return pacificTime;
    } catch (error) {
        console.error('Error in utcToPacificTime:', error.message);
        return '09:00';
    }
}

function getPacificDateRange(pacificDateStr) {
    try {
        const startUTC = pacificTimeToUTC(pacificDateStr, '00:00');
        const endUTC = pacificTimeToUTC(pacificDateStr, '23:59');
        return { start: startUTC, end: endUTC };
    } catch (error) {
        console.error('Error in getPacificDateRange:', error.message);
        return {
            start: `${pacificDateStr}T00:00:00.000Z`,
            end: `${pacificDateStr}T23:59:59.999Z`
        };
    }
}

// Get today's tasks with correct property names and error handling
async function getTodaysTasks(today) {
    try {
        if (!today || typeof today !== 'string') {
            console.error('Invalid today parameter:', today);
            return [];
        }
        
        console.log('Querying tasks database with correct properties...');
        
        const todayPacific = new Date(today + 'T23:59:59');
        const todayUTC = todayPacific.toISOString().split('T')[0];
        
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                and: [
                    {
                        or: [
                            {
                                property: 'Due Date',
                                date: { on_or_before: todayUTC }
                            },
                            {
                                property: 'Schedule Today?',
                                checkbox: { equals: true }
                            }
                        ]
                    },
                    {
                        property: 'Status',
                        select: { does_not_equal: 'Done' }
                    }
                ]
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 50
        });

        console.log(`Found ${tasksResponse.results.length} tasks in database`);

        return tasksResponse.results.map(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn('Skipping task with empty title:', task.id);
                    return null;
                }
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || 'Admin';
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                
                const routine = priority === 'Routine' || 
                               type === 'Routine' || 
                               title.toLowerCase().includes('routine') ||
                               title.toLowerCase().includes('daily');
                
                let priorityScore = 3;
                switch(priority) {
                    case 'High':
                        priorityScore = 1;
                        break;
                    case 'Routine':
                        priorityScore = 2;
                        break;
                    case 'Medium':
                        priorityScore = 3;
                        break;
                    case 'Low':
                        priorityScore = 5;
                        break;
                    default:
                        console.warn(`Unknown priority level: ${priority}, using Medium`);
                        priorityScore = 3;
                }
                
                if (dueDate) {
                    try {
                        const dueDateTime = new Date(dueDate);
                        const todayDateTime = new Date(today);
                        const dueDays = Math.ceil((dueDateTime - todayDateTime) / (1000 * 60 * 60 * 24));
                        
                        if (dueDays <= 0) priorityScore = Math.max(1, priorityScore - 2);
                        else if (dueDays <= 1) priorityScore = Math.max(1, priorityScore - 1);
                    } catch (dateError) {
                        console.warn(`Error parsing due date for task ${title}:`, dateError.message);
                    }
                }
                
                return {
                    title: title.trim(),
                    priority,
                    priorityScore,
                    type: type?.toLowerCase() || 'admin',
                    routine,
                    estimatedTime: Math.max(30, estimatedTime || 30),
                    dueDate,
                    id: task.id,
                    used: false
                };
            } catch (taskError) {
                console.error('Error processing individual task:', taskError.message);
                return null;
            }
        }).filter(task => task !== null);
        
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        console.error('Full error details:', error);
        return [];
    }
}

// Utility functions
function addMinutes(timeStr, minutes) {
    try {
        const [hours, mins] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(mins)) {
            throw new Error(`Invalid time format: ${timeStr}`);
        }
        
        const totalMins = hours * 60 + mins + minutes;
        const newHours = Math.floor(totalMins / 60) % 24;
        const newMins = totalMins % 60;
        return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
    } catch (error) {
        console.error('Error in addMinutes:', error.message);
        return timeStr;
    }
}

function getMinutesBetween(startTime, endTime) {
    try {
        const [startHours, startMins] = startTime.split(':').map(Number);
        const [endHours, endMins] = endTime.split(':').map(Number);
        
        if (isNaN(startHours) || isNaN(startMins) || isNaN(endHours) || isNaN(endMins)) {
            throw new Error(`Invalid time format: ${startTime} to ${endTime}`);
        }
        
        const startTotalMins = startHours * 60 + startMins;
        const endTotalMins = endHours * 60 + endMins;
        
        if (endTotalMins < startTotalMins) {
            console.warn(`End time ${endTime} before start time ${startTime} - assuming 0 duration`);
            return 0;
        }
        
        return endTotalMins - startTotalMins;
    } catch (error) {
        console.error('Error in getMinutesBetween:', error.message);
        return 0;
    }
}

// Smart task assignment function with better error handling
function assignBestTask(availableTasks, blockType) {
    if (!availableTasks || !Array.isArray(availableTasks) || availableTasks.length === 0) {
        return null;
    }
    
    const unusedTasks = availableTasks.filter(t => t && !t.used && t.title);
    if (unusedTasks.length === 0) {
        return null;
    }
    
    let selectedTask = null;
    
    if (blockType === 'Deep Work') {
        const highPriorityTasks = unusedTasks.filter(t => t.priorityScore <= 2);
        if (highPriorityTasks.length > 0) {
            selectedTask = highPriorityTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
        }
    }
    
    if (blockType === 'Routine' && !selectedTask) {
        const routineTasks = unusedTasks.filter(t => t.routine);
        if (routineTasks.length > 0) {
            selectedTask = routineTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
        }
    }
    
    if (!selectedTask) {
        selectedTask = unusedTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
    }
    
    if (selectedTask) {
        selectedTask.used = true;
        console.log(`Assigned task "${selectedTask.title}" (Priority: ${selectedTask.priority}, Score: ${selectedTask.priorityScore}) to ${blockType} block`);
    }
    
    return selectedTask;
}

// Work shift detection
async function getWorkShift(today) {
    if (!calendarEnabled) {
        console.log('Calendar disabled, assuming home day');
        return { 
            isWorkDay: false, 
            isAtSite: false,
            startTime: '09:00', 
            endTime: '17:00', 
            title: 'Home Day'
        };
    }

    try {
        const dayRange = getPacificDateRange(today);
        
        const workEvents = await calendar.events.list({
            calendarId: WORK_SITE_CALENDAR_ID,
            timeMin: dayRange.start,
            timeMax: dayRange.end,
            singleEvents: true,
            maxResults: 10
        });

        const hasWorkEvents = workEvents.data.items && workEvents.data.items.length > 0;
        
        if (hasWorkEvents) {
            console.log(`Found ${workEvents.data.items.length} work site events - at site`);
            return {
                isWorkDay: true,
                isAtSite: true,
                startTime: '05:30',
                endTime: '17:30',
                title: 'Site Work Day'
            };
        } else {
            console.log('No work site events found - home day');
            return {
                isWorkDay: false,
                isAtSite: false,
                startTime: '09:00',
                endTime: '17:00',
                title: 'Home Day'
            };
        }
        
    } catch (error) {
        console.error('Error checking work site calendar:', error.message);
        return {
            isWorkDay: false,
            isAtSite: false,
            startTime: '09:00',
            endTime: '17:00',
            title: 'Home Day (Error)'
        };
    }
}

// Get morning log data using ACTUAL properties from Daily Logs
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '04:30',
        energy: 7,
        mood: 'Steady',
        focusCapacity: 'Normal',
        socialBattery: 'Full',
        sleepQuality: 7,
        sleepHours: 7,
        bodyStatus: 'Normal',
        stressLevel: 'Normal',
        weatherImpact: 'None'
    };
    
    try {
        console.log('Getting today\'s morning log with ALL parameters for intelligent scheduling...');
        const morningLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        if (morningLogResponse.results.length === 0) {
            console.log('No morning log found for today, using defaults');
            return defaultData;
        }

        const log = morningLogResponse.results[0].properties;
        const data = { ...defaultData };
        
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            data.wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        const energyValue = log['Energy']?.select?.name;
        if (energyValue && !isNaN(parseInt(energyValue))) {
            data.energy = parseInt(energyValue);
        }
        
        data.mood = log['Mood']?.select?.name || 'Steady';
        data.focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        data.socialBattery = log['Social Battery']?.select?.name || 'Full';
        data.bodyStatus = log['Body Status']?.select?.name || 'Normal';
        data.stressLevel = log['Stress Level']?.select?.name || 'Normal';
        data.weatherImpact = log['Weather Impact']?.select?.name || 'None';
        
        data.sleepQuality = log['Sleep Quality']?.number || 7;
        data.sleepHours = log['Sleep Hours']?.number || 7;
        
        console.log('Parsed comprehensive morning log data:', {
            energy: data.energy,
            mood: data.mood,
            focus: data.focusCapacity,
            social: data.socialBattery,
            body: data.bodyStatus,
            stress: data.stressLevel,
            sleepQuality: data.sleepQuality,
            sleepHours: data.sleepHours
        });
        
        return data;
        
    } catch (error) {
        console.error('Error fetching morning log:', error.message);
        return defaultData;
    }
}

// Intelligent work day schedule using REAL task data and morning log
function createWorkDaySchedule(wakeTime, workShift, allTasks, morningData) {
    if (!wakeTime || !workShift || !morningData) {
        console.error('Missing required parameters for work day schedule');
        return [];
    }
    
    if (!Array.isArray(allTasks)) {
        console.error('allTasks is not an array:', typeof allTasks);
        allTasks = [];
    }
    
    const safeData = {
        energy: Math.max(1, Math.min(10, morningData.energy || 7)),
        focusCapacity: morningData.focusCapacity || 'Normal',
        mood: morningData.mood || 'Steady',
        bodyStatus: morningData.bodyStatus || 'Normal',
        stressLevel: morningData.stressLevel || 'Normal',
        socialBattery: morningData.socialBattery || 'Full',
        sleepHours: Math.max(4, Math.min(12, morningData.sleepHours || 7)),
        sleepQuality: Math.max(1, Math.min(10, morningData.sleepQuality || 7))
    };
    
    console.log(`Creating work day schedule - Energy: ${safeData.energy}/10, Focus: ${safeData.focusCapacity}, Tasks: ${allTasks.length}`);
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const tasksCopy = allTasks.map(t => ({...t, used: false}));
    
    const energyLevel = safeData.energy;
    const canDeepFocus = safeData.focusCapacity === 'Sharp' && energyLevel >= 7;
    const needsFrequentBreaks = safeData.stressLevel === 'Maxed Out' || 
                                safeData.bodyStatus === 'Tired' || 
                                safeData.sleepHours < 6;
    
    const breakFrequency = needsFrequentBreaks ? 60 : (energyLevel < 6 ? 75 : 90);
    
    const highPriorityTasks = tasksCopy.filter(t => t.priorityScore <= 2).sort((a, b) => a.priorityScore - b.priorityScore);
    const routineTasks = tasksCopy.filter(t => t.routine).sort((a, b) => a.priorityScore - b.priorityScore);
    const regularTasks = tasksCopy.filter(t => !t.routine && t.priorityScore > 2).sort((a, b) => a.priorityScore - b.priorityScore);
    
    console.log(`Task breakdown: ${highPriorityTasks.length} high priority, ${routineTasks.length} routine, ${regularTasks.length} regular`);
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine (Work Camp)',
        start: currentTime,
        duration: 30,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // Morning planning
    schedule.push({
        title: 'Morning Planning & Setup',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Work',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 30);
    
    let consecutiveWorkMinutes = 30;
    
    // Routine tasks phase (until 10 AM)
    const routineEndTime = '10:00';
    while (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const nextRoutineTask = assignBestTask(routineTasks, 'Routine');
        
        if (nextRoutineTask) {
            schedule.push({
                title: nextRoutineTask.title,
                start: currentTime,
                duration: Math.min(30, nextRoutineTask.estimatedTime || 30),
                type: 'Routine',
                context: 'Work',
                energy: 'Med',
                taskId: nextRoutineTask.id
            });
            console.log(`✓ Scheduled routine task: ${nextRoutineTask.title}`);
        } else {
            schedule.push({
                title: 'Morning Admin & Communications',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Med'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, routineEndTime) >= 45) {
            schedule.push({
                title: 'Energy Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Energy Break');
        }
    }
    currentTime = routineEndTime;
    consecutiveWorkMinutes = 0;
    
    // Peak focus phase (10 AM - 12 PM)
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        const highPriorityTask = assignBestTask(highPriorityTasks, 'Deep Work');
        
        if (highPriorityTask && canDeepFocus) {
            schedule.push({
                title: highPriorityTask.title,
                start: currentTime,
                duration: Math.min(30, highPriorityTask.estimatedTime || 30),
                type: 'Deep Work',
                context: 'Work',
                energy: 'High',
                taskId: highPriorityTask.id
            });
            console.log(`✓ Scheduled HIGH PRIORITY task: ${highPriorityTask.title}`);
        } else if (canDeepFocus) {
            const anyUrgentTask = assignBestTask([...regularTasks, ...tasksCopy.filter(t => !t.used)], 'Deep Work');
            if (anyUrgentTask) {
                schedule.push({
                    title: anyUrgentTask.title,
                    start: currentTime,
                    duration: Math.min(30, anyUrgentTask.estimatedTime || 30),
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: anyUrgentTask.id
                });
                console.log(`✓ Scheduled deep work task: ${anyUrgentTask.title}`);
            } else {
                schedule.push({
                    title: 'Deep Focus Session',
                    start: currentTime,
                    duration: 30,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High'
                });
                console.log('✓ Created generic Deep Focus (no tasks available)');
            }
        } else {
            const anyTask = assignBestTask([...tasksCopy.filter(t => !t.used)], 'Admin');
            if (anyTask) {
                schedule.push({
                    title: anyTask.title,
                    start: currentTime,
                    duration: Math.min(30, anyTask.estimatedTime || 30),
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med',
                    taskId: anyTask.id
                });
                console.log(`✓ Scheduled admin task: ${anyTask.title}`);
            } else {
                schedule.push({
                    title: 'Project Work',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= (canDeepFocus ? 90 : 60) && getMinutesBetween(currentTime, deepWorkEnd) >= 45) {
            schedule.push({
                title: 'Focus Recovery Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Focus Recovery Break');
        }
    }
    currentTime = deepWorkEnd;
    
    // Lunch break
    const lunchDuration = (energyLevel <= 5 || safeData.stressLevel === 'Maxed Out') ? 75 : 60;
    schedule.push({
        title: lunchDuration > 60 ? 'Extended Lunch & Recovery' : 'Lunch Break',
        start: currentTime,
        duration: lunchDuration,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, lunchDuration);
    consecutiveWorkMinutes = 0;
    
    // Afternoon work (post-lunch to 16:00)
    const afternoonWorkEnd = '16:00';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const remainingTask = assignBestTask([...regularTasks, ...tasksCopy.filter(t => !t.used)], 'Admin');
        
        if (remainingTask) {
            const blockType = (remainingTask.priorityScore <= 2 && energyLevel >= 6) ? 'Deep Work' : 'Admin';
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: Math.min(30, remainingTask.estimatedTime || 30),
                type: blockType,
                context: 'Work',
                energy: blockType === 'Deep Work' ? 'High' : 'Med',
                taskId: remainingTask.id
            });
            console.log(`✓ Scheduled afternoon task: ${remainingTask.title}`);
        } else {
            const currentHour = parseInt(currentTime.split(':')[0]);
            if (currentHour === 13 && energyLevel >= 6) {
                schedule.push({
                    title: 'Afternoon Project Focus',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            } else {
                schedule.push({
                    title: 'Administrative Work',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, afternoonWorkEnd) >= 45) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Afternoon Break');
        }
    }
    currentTime = afternoonWorkEnd;
    
    // End of day (16:00-17:30)
    while (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
        const lightTask = assignBestTask(tasksCopy.filter(t => !t.used && t.priorityScore >= 4), 'Admin');
        
        if (lightTask) {
            schedule.push({
                title: lightTask.title,
                start: currentTime,
                duration: Math.min(30, lightTask.estimatedTime || 30),
                type: 'Admin',
                context: 'Work',
                energy: 'Low',
                taskId: lightTask.id
            });
            console.log(`✓ Scheduled end-of-day task: ${lightTask.title}`);
        } else {
            schedule.push({
                title: 'End of Day Wrap-up',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Low'
            });
        }
        currentTime = addMinutes(currentTime, 30);
    }
    currentTime = workShift.endTime || '17:30';
    
    // Evening routine
    schedule.push({
        title: 'Day Review & Tomorrow Planning',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    while (getMinutesBetween(currentTime, '22:00') >= 30) {
        schedule.push({
            title: 'Personal Time',
            start: currentTime,
            duration: 30,
            type: 'Events',
            context: 'Personal',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    const tasksScheduled = tasksCopy.filter(t => t.used).length;
    console.log(`✅ Work schedule created: ${schedule.length} blocks, ${tasksScheduled}/${allTasks.length} tasks scheduled`);
    
    return schedule;
}

// Home day schedule using REAL task data and morning log
function createHomeDaySchedule(wakeTime, allTasks, morningData) {
    if (!wakeTime || !morningData) {
        console.error('Missing required parameters for home day schedule');
        return [];
    }
    
    if (!Array.isArray(allTasks)) {
        console.error('allTasks is not an array:', typeof allTasks);
        allTasks = [];
    }
    
    const safeData = {
        energy: Math.max(1, Math.min(10, morningData.energy || 7)),
        focusCapacity: morningData.focusCapacity || 'Normal',
        mood: morningData.mood || 'Steady',
        bodyStatus: morningData.bodyStatus || 'Normal',
        stressLevel: morningData.stressLevel || 'Normal',
        socialBattery: morningData.socialBattery || 'Full',
        sleepHours: Math.max(4, Math.min(12, morningData.sleepHours || 7)),
        sleepQuality: Math.max(1, Math.min(10, morningData.sleepQuality || 7))
    };
    
    console.log(`Creating home day schedule - Energy: ${safeData.energy}/10, Focus: ${safeData.focusCapacity}, Tasks: ${allTasks.length}`);
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const tasksCopy = allTasks.map(t => ({...t, used: false}));
    
    const energyLevel = safeData.energy;
    const canDeepFocus = safeData.focusCapacity === 'Sharp' && energyLevel >= 7;
    const needsFrequentBreaks = safeData.stressLevel === 'Maxed Out' || 
                                safeData.bodyStatus === 'Tired' || 
                                safeData.sleepHours < 6;
    
    const breakFrequency = needsFrequentBreaks ? 60 : (energyLevel < 6 ? 75 : 90);
    
    const highPriorityTasks = tasksCopy.filter(t => t.priorityScore <= 2).sort((a, b) => a.priorityScore - b.priorityScore);
    const routineTasks = tasksCopy.filter(t => t.routine).sort((a, b) => a.priorityScore - b.priorityScore);
    const regularTasks = tasksCopy.filter(t => !t.routine && t.priorityScore > 2).sort((a, b) => a.priorityScore - b.priorityScore);
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine & Recovery',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 60);
    
    schedule.push({
        title: 'Morning Planning & Setup',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 30);
    
    let consecutiveWorkMinutes = 30;
    
    // Routine tasks (until 10 AM)
    const routineEndTime = '10:00';
    while (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const nextRoutineTask = assignBestTask(routineTasks, 'Routine');
        
        if (nextRoutineTask) {
            schedule.push({
                title: nextRoutineTask.title,
                start: currentTime,
                duration: Math.min(30, nextRoutineTask.estimatedTime || 30),
                type: 'Routine',
                context: 'Work',
                energy: 'Med',
                taskId: nextRoutineTask.id
            });
            console.log(`✓ Scheduled routine task: ${nextRoutineTask.title}`);
        } else {
            schedule.push({
                title: 'Morning Admin Tasks',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Personal',
                energy: 'Med'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, routineEndTime) >= 45) {
            schedule.push({
                title: 'Morning Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Morning Break');
        }
    }
    currentTime = routineEndTime;
    consecutiveWorkMinutes = 0;
    
    // Focus work (10 AM - 12 PM)
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        if (canDeepFocus) {
            const highPriorityTask = assignBestTask(highPriorityTasks, 'Deep Work');
            if (highPriorityTask) {
                schedule.push({
                    title: highPriorityTask.title,
                    start: currentTime,
                    duration: Math.min(30, highPriorityTask.estimatedTime || 30),
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: highPriorityTask.id
                });
                console.log(`✓ Scheduled HIGH PRIORITY deep work: ${highPriorityTask.title}`);
            } else {
                const anyUrgentTask = assignBestTask([...regularTasks, ...tasksCopy.filter(t => !t.used)], 'Deep Work');
                if (anyUrgentTask) {
                    schedule.push({
                        title: anyUrgentTask.title,
                        start: currentTime,
                        duration: Math.min(30, anyUrgentTask.estimatedTime || 30),
                        type: 'Deep Work',
                        context: 'Work',
                        energy: 'High',
                        taskId: anyUrgentTask.id
                    });
                    console.log(`✓ Scheduled deep work task: ${anyUrgentTask.title}`);
                } else {
                    schedule.push({
                        title: 'Deep Focus Session',
                        start: currentTime,
                        duration: 30,
                        type: 'Deep Work',
                        context: 'Work',
                        energy: 'High'
                    });
                    console.log('✓ Created generic Deep Focus (no tasks available)');
                }
            }
        } else {
            const anyTask = assignBestTask([...tasksCopy.filter(t => !t.used)], 'Admin');
            if (anyTask) {
                schedule.push({
                    title: anyTask.title,
                    start: currentTime,
                    duration: Math.min(30, anyTask.estimatedTime || 30),
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med',
                    taskId: anyTask.id
                });
                console.log(`✓ Scheduled admin task: ${anyTask.title}`);
            } else {
                schedule.push({
                    title: 'Project Work',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= (canDeepFocus ? 90 : 60) && getMinutesBetween(currentTime, deepWorkEnd) >= 45) {
            schedule.push({
                title: 'Focus Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Focus Break');
        }
    }
    currentTime = deepWorkEnd;
    
    // Lunch
    schedule.push({
        title: 'Lunch Break',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    consecutiveWorkMinutes = 0;
    
    // Afternoon work (13:00 - 15:30)
    const afternoonWorkEnd = '15:30';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const remainingTask = assignBestTask([...regularTasks, ...tasksCopy.filter(t => !t.used)], 'Admin');
        
        if (remainingTask) {
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: Math.min(30, remainingTask.estimatedTime || 30),
                type: 'Admin',
                context: 'Work',
                energy: 'Med',
                taskId: remainingTask.id
            });
            console.log(`✓ Scheduled afternoon task: ${remainingTask.title}`);
        } else {
            schedule.push({
                title: 'Afternoon Project Work',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Med'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, afternoonWorkEnd) >= 45) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Afternoon Break');
        }
    }
    currentTime = afternoonWorkEnd;
    
    // Riley Time
    schedule.push({
        title: 'Riley Time (After School)',
        start: currentTime,
        duration: 120,
        type: 'Events',
        context: 'Family',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 120);
    
    // Dinner & Family Time
    schedule.push({
        title: 'Dinner & Family Time',
        start: currentTime,
        duration: 90,
        type: 'Events',
        context: 'Family',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 90);
    
    // Evening wrap-up
    schedule.push({
        title: 'Day Review & Tomorrow Planning',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    while (getMinutesBetween(currentTime, '22:00') >= 30) {
        schedule.push({
            title: 'Personal Time',
            start: currentTime,
            duration: 30,
            type: 'Events',
            context: 'Personal',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    const tasksScheduled = tasksCopy.filter(t => t.used).length;
    console.log(`✅ Home schedule created: ${schedule.length} blocks, ${tasksScheduled}/${allTasks.length} tasks scheduled`);
    
    return schedule;
}

// Clear existing blocks
async function clearAutoFilledBlocks(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: dayRange.start,
                    on_or_before: dayRange.end
                }
            },
            page_size: 100
        });

        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        console.log(`Cleared ${existing.results.length} existing blocks`);
    } catch (error) {
        console.error('Error clearing blocks:', error.message);
    }
}

// Create time blocks with correct Energy Requirements values
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`Creating ${schedule.length} time blocks with task relations...`);
    
    const results = [];
    
    const energyMapping = {
        'Low': 'Low',
        'Medium': 'Med',
        'High': 'High'
    };
    
    for (const block of schedule) {
        try {
            if (!block || !block.title || !block.start || !block.duration) {
                console.warn('Skipping invalid block:', block);
                continue;
            }
            
            const endTime = addMinutes(block.start, block.duration);
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            const mappedEnergy = energyMapping[block.energy] || 'Med';
            
            const properties = {
                Title: { title: [{ text: { content: block.title } }] },
                Type: { select: { name: block.type } },
                Context: { select: { name: block.context } },
                'Energy Requirements': { select: { name: mappedEnergy } },
                Status: { select: { name: 'Active' } },
                'Start Time': { date: { start: startUTC } },
                'End Time': { date: { start: endUTC } },
                'Auto-Filled': { checkbox: true }
            };
            
            if (block.taskId && typeof block.taskId === 'string') {
                properties['Tasks'] = { relation: [{ id: block.taskId }] };
                console.log(`Linking task ${block.taskId} to time block "${block.title}"`);
            }
            
            if (dailyLogId && typeof dailyLogId === 'string') {
                properties['Daily Logs'] = { relation: [{ id: dailyLogId }] };
            }
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: properties
            });
            
            results.push({
                title: block.title,
                startTime: block.start,
                endTime: endTime,
                type: block.type,
                context: block.context,
                energy: mappedEnergy,
                taskId: block.taskId || null,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`Failed to create block "${block?.title || 'Unknown'}":`, error.message);
            results.push({
                title: block?.title || 'Unknown Block',
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    return results;
}

async function getDailyLogId(today) {
    try {
        const dailyLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        return dailyLogResponse.results.length > 0 ? dailyLogResponse.results[0].id : null;
    } catch (error) {
        console.error('Error getting daily log ID:', error.message);
        return null;
    }
}

// Main workflow with comprehensive error handling and input validation
async function runEnhancedScheduler(today) {
    console.log('Starting FIXED enhanced scheduler workflow...');
    
    if (!today || typeof today !== 'string') {
        throw new Error('Invalid today parameter - must be a valid date string');
    }
    
    let lastCreationResult = null;
    
    try {
        await clearAutoFilledBlocks(today);
        
        const morningData = await getEnhancedMorningLog(today);
        if (!morningData) {
            throw new Error('Failed to get morning log data');
        }
        
        const workShift = await getWorkShift(today);
        if (!workShift) {
            throw new Error('Failed to get work shift data');
        }
        
        console.log('Fetching tasks with CORRECT property names...');
        const allTasks = await getTodaysTasks(today);
        
        if (!Array.isArray(allTasks)) {
            console.error('getTodaysTasks returned invalid data:', typeof allTasks);
            throw new Error('Task fetching returned invalid data');
        }
        
        console.log(`Successfully fetched ${allTasks.length} tasks for intelligent scheduling`);
        
        console.log('Generating intelligent schedule using REAL morning log data...');
        let schedule;
        
        if (workShift.isWorkDay) {
            console.log('Creating INTELLIGENT work day schedule...');
            schedule = createWorkDaySchedule(
                morningData.wakeTime, 
                workShift, 
                allTasks,
                morningData
            );
        } else {
            console.log('Creating INTELLIGENT home day schedule...');
            schedule = createHomeDaySchedule(
                morningData.wakeTime, 
                allTasks,
                morningData
            );
        }
        
        if (!Array.isArray(schedule) || schedule.length === 0) {
            throw new Error('Schedule generation failed - no blocks created');
        }
        
        console.log(`Generated schedule with ${schedule.length} blocks`);
        
        console.log('Creating time blocks in Notion...');
        const dailyLogId = await getDailyLogId(today);
        const createdBlocks = await createTimeBlocks(schedule, today, dailyLogId);
        
        if (!Array.isArray(createdBlocks)) {
            throw new Error('Block creation returned invalid results');
        }
        
        const tasksScheduled = createdBlocks.filter(b => b && b.taskId).length;
        const successfulBlocks = createdBlocks.filter(b => b && b.status === 'created').length;
        const failedBlocks = createdBlocks.filter(b => b && b.status === 'failed').length;
        
        lastCreationResult = {
            success: successfulBlocks,
            failed: failedBlocks,
            tasksScheduled: tasksScheduled,
            totalTasks: allTasks.length,
            wakeTime: morningData.wakeTime,
            workDay: workShift.isWorkDay,
            energy: morningData.energy,
            focus: morningData.focusCapacity,
            timestamp: new Date().toISOString()
        };
        
        if (typeof global !== 'undefined') {
            global.lastCreationResult = lastCreationResult;
        } else {
            globalThis.lastCreationResult = lastCreationResult;
        }
        
        console.log(`FIXED scheduler completed: ${successfulBlocks} blocks created, ${tasksScheduled} tasks scheduled, ${failedBlocks} failed`);
        
        return {
            created: createdBlocks,
            morningData: morningData,
            workShift: workShift,
            tasksFound: allTasks.length,
            tasksScheduled: tasksScheduled,
            summary: lastCreationResult
        };
        
    } catch (error) {
        console.error('Critical failure in FIXED scheduler:', error.message);
        console.error('Error stack:', error.stack);
        
        const errorResult = {
            success: 0,
            failed: 1,
            error: error.message,
            timestamp: new Date().toISOString()
        };
        
        if (typeof global !== 'undefined') {
            global.lastCreationResult = errorResult;
        } else {
            globalThis.lastCreationResult = errorResult;
        }
        
        throw error;
    }
}

// Display current schedule with proper timezone handling
async function getCurrentSchedule(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
        console.log(`Getting schedule for ${today} Pacific`);
        
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: dayRange.start,
                    on_or_before: dayRange.end
                }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 100
        });

        console.log(`Found ${timeBlocks.results.length} blocks in Notion for ${today}`);

        if (timeBlocks.results.length === 0) {
            return [];
        }

        const schedule = timeBlocks.results.map(block => {
            try {
                const startTime = block.properties['Start Time']?.date?.start;
                const endTime = block.properties['End Time']?.date?.start;
                const title = block.properties.Title?.title?.[0]?.text?.content || 'Untitled';
                const type = block.properties.Type?.select?.name || 'Events';
                const context = block.properties.Context?.select?.name || 'Personal';
                const autoFilled = block.properties['Auto-Filled']?.checkbox || false;
                const hasTask = block.properties.Tasks?.relation?.length > 0;

                if (!startTime) return null;

                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                const startUTC = new Date(startTime);
                const pacificDateString = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Vancouver',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }).format(startUTC);
                
                if (pacificDateString !== today) {
                    return null;
                }

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: getTypeClass(type),
                    energy: 'medium',
                    details: `${context} • ${type}${hasTask ? ' • Task Assigned' : ''}${autoFilled ? ' • AI Enhanced' : ''}`
                };
            } catch (error) {
                console.error('Error processing schedule block:', error.message);
                return null;
            }
        }).filter(block => block !== null);

        console.log(`Returning ${schedule.length} formatted blocks for today`);
        return schedule;

    } catch (error) {
        console.error('Failed to get current schedule:', error.message);
        return [];
    }
}

function getTypeClass(type) {
    const typeMapping = {
        'Deep Work': 'deep-work',
        'Admin': 'admin',
        'Events': 'personal',
        'Meeting': 'meeting',
        'Routine': 'routine',
        'Appointment': 'meeting',
        'Travel': 'admin'
    };
    
    return typeMapping[type] || 'personal';
}

// Vercel handler
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('FIXED Scheduler v4.0 - Intelligent Task Assignment & Smart Breaks');
        
        if (!process.env.NOTION_TOKEN) {
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing NOTION_TOKEN'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        
        console.log(`Processing request: action=${action}, date=${today}`);
        
        if (action === 'create') {
            console.log('Running FIXED scheduler with task assignment...');
            await runEnhancedScheduler(today);
        }

        const schedule = await getCurrentSchedule(today);
        const now = new Date();
        const processingTime = Date.now() - startTime;
        
        const response = {
            schedule: schedule,
            meta: {
                totalBlocks: schedule.length,
                creationAttempted: action === 'create',
                lastCreationResult: (typeof global !== 'undefined' ? global.lastCreationResult : globalThis.lastCreationResult) || null,
                processingTimeMs: processingTime,
                timestamp: now.toISOString(),
                version: '4.0-Fixed-Task-Assignment',
                calendarEnabled: calendarEnabled
            },
            display: {
                lastUpdate: now.toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZone: 'America/Vancouver'
                }),
                date: now.toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                }),
                timezone: 'Pacific Time'
            }
        };

        console.log(`FIXED request completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('FIXED Scheduler Error:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({ 
            error: 'FIXED scheduler failed',
            details: error.message,
            stack: error.stack,
            meta: {
                version: '4.0-Fixed-Task-Assignment',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};
