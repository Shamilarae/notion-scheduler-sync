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

// FIXED: Get today's tasks with correct property names
async function getTodaysTasks(today) {
    try {
        console.log('Querying tasks database with correct properties...');
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                and: [
                    {
                        or: [
                            {
                                property: 'Due Date',
                                date: { on_or_before: today }
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
            const props = task.properties;
            const title = props.Name?.title?.[0]?.text?.content || 'Untitled Task';
            const priority = props['Priority Level']?.select?.name || 'Medium';
            const type = props.Type?.select?.name || 'Admin';
            const estimatedTime = props['Estimated Duration']?.number || 30;
            const dueDate = props['Due Date']?.date?.start;
            
            // Determine if it's routine
            const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
            
            // Calculate priority score for intelligent scheduling
            let priorityScore = 3; // Default medium
            if (priority === 'High') priorityScore = 1;
            else if (priority === 'Routine') priorityScore = 2;
            else if (priority === 'Low') priorityScore = 5;
            
            // Boost priority if due soon
            if (dueDate) {
                const dueDays = Math.ceil((new Date(dueDate) - new Date(today)) / (1000 * 60 * 60 * 24));
                if (dueDays <= 0) priorityScore = Math.max(1, priorityScore - 2); // Overdue = highest priority
                else if (dueDays <= 1) priorityScore = Math.max(1, priorityScore - 1); // Due today/tomorrow
            }
            
            return {
                title,
                priority,
                priorityScore,
                type: type?.toLowerCase() || 'admin',
                routine,
                estimatedTime: Math.max(30, estimatedTime),
                dueDate,
                id: task.id,
                used: false // Track if task has been scheduled
            };
        });
    } catch (error) {
        console.error('Error getting tasks:', error.message);
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

// FIXED: Smart task assignment function
function assignBestTask(availableTasks, blockType, preferredPriority = null) {
    if (!availableTasks || availableTasks.length === 0) return null;
    
    // Filter unused tasks
    const unusedTasks = availableTasks.filter(t => !t.used);
    if (unusedTasks.length === 0) return null;
    
    // For Deep Work blocks, prioritize high-priority tasks
    if (blockType === 'Deep Work') {
        const highPriorityTasks = unusedTasks.filter(t => t.priorityScore <= 2);
        if (highPriorityTasks.length > 0) {
            const task = highPriorityTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
            task.used = true;
            return task;
        }
    }
    
    // For routine blocks, prioritize routine tasks
    if (blockType === 'Routine') {
        const routineTasks = unusedTasks.filter(t => t.routine);
        if (routineTasks.length > 0) {
            const task = routineTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
            task.used = true;
            return task;
        }
    }
    
    // For admin blocks, pick any suitable task
    const task = unusedTasks.sort((a, b) => a.priorityScore - b.priorityScore)[0];
    task.used = true;
    return task;
}

// FIXED: Smart break logic with better error handling - no breaks immediately after arrival or right before lunch
function shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, workStartTime, nextMealTime = null) {
    try {
        // FIXED: Validate inputs
        if (!currentTime || !workStartTime || typeof consecutiveWorkMinutes !== 'number') {
            return false;
        }
        
        const [currentHour, currentMinutes] = currentTime.split(':').map(Number);
        const [workStartHour] = workStartTime.split(':').map(Number);
        
        // Validate parsed numbers
        if (isNaN(currentHour) || isNaN(currentMinutes) || isNaN(workStartHour)) {
            console.warn('Invalid time format in shouldInsertBreak');
            return false;
        }
        
        // No break within first hour of work
        if (currentHour === workStartHour || (currentHour === workStartHour + 1 && currentMinutes < 30)) {
            return false;
        }
        
        // No break within 30 minutes of lunch (assume lunch at 12:00)
        if (nextMealTime) {
            try {
                const [mealHour, mealMinutes] = nextMealTime.split(':').map(Number);
                if (!isNaN(mealHour) && !isNaN(mealMinutes)) {
                    const minutesToMeal = (mealHour * 60 + mealMinutes) - (currentHour * 60 + currentMinutes);
                    if (minutesToMeal <= 30 && minutesToMeal > 0) {
                        return false;
                    }
                }
            } catch (mealError) {
                console.warn('Error parsing meal time:', mealError.message);
            }
        }
        
        // Standard break logic
        const minWorkBeforeBreak = 90; // 1.5 hours minimum
        const timeSinceLastBreak = lastBreakTime ? 
            getMinutesBetween(lastBreakTime, currentTime) : 
            consecutiveWorkMinutes;
        
        return consecutiveWorkMinutes >= minWorkBeforeBreak && timeSinceLastBreak >= 90;
    } catch (error) {
        console.error('Error in shouldInsertBreak:', error.message);
        return false; // Fail safe - no break if error
    }
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

// Get morning log data
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '04:30',
        energy: 7,
        mood: 'Steady',
        focusCapacity: 'Normal',
        socialBattery: 'Full',
        sleepQuality: 7
    };
    
    try {
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
        data.sleepQuality = log['Sleep Quality']?.number || 7;
        
        console.log('Successfully parsed morning log data');
        return data;
        
    } catch (error) {
        console.error('Error fetching morning log:', error.message);
        return defaultData;
    }
}

// COMPLETELY REWRITTEN: Intelligent work day schedule with ROBUST error handling
function createWorkDaySchedule(wakeTime, workShift, allTasks, morningData) {
    // CRITICAL: Input validation to prevent crashes
    if (!wakeTime || !workShift || !morningData) {
        console.error('Missing required parameters for work day schedule');
        return [];
    }
    
    if (!Array.isArray(allTasks)) {
        console.error('allTasks is not an array:', typeof allTasks);
        allTasks = [];
    }
    
    // FIXED: Validate morning data properties with defaults
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
    
    console.log(`Creating INTELLIGENT work day schedule based on validated morning log data:`);
    console.log(`- Energy: ${safeData.energy}/10`);
    console.log(`- Focus: ${safeData.focusCapacity}`);
    console.log(`- Mood: ${safeData.mood}`);
    console.log(`- Body: ${safeData.bodyStatus}`);
    console.log(`- Stress: ${safeData.stressLevel}`);
    console.log(`- Sleep: ${safeData.sleepHours}h @ quality ${safeData.sleepQuality}/10`);
    console.log(`- Available tasks: ${allTasks.length}`);
    
    let schedule = [];
    let currentTime = wakeTime;
    let consecutiveWorkMinutes = 0;
    let lastBreakTime = null;
    
    // FIXED: Create separate task arrays to avoid reference issues
    const tasksCopy = allTasks.map(t => ({...t, used: false}));
    
    // INTELLIGENT PARAMETERS based on validated morning log
    const energyLevel = safeData.energy;
    const isHighEnergy = energyLevel >= 8;
    const isMediumEnergy = energyLevel >= 6;
    const isLowEnergy = energyLevel < 6;
    
    const canDeepFocus = safeData.focusCapacity === 'Sharp' && energyLevel >= 7;
    const needsFrequentBreaks = safeData.stressLevel === 'Maxed Out' || 
                                safeData.bodyStatus === 'Tired' || 
                                safeData.sleepHours < 6;
    const socialCapable = safeData.socialBattery !== 'Drained';
    
    // Calculate break frequency based on conditions
    const breakFrequency = needsFrequentBreaks ? 60 : // Every hour if stressed/tired
                          isLowEnergy ? 75 : // Every 1.25 hours if low energy
                          90; // Standard 1.5 hours
    
    console.log(`Intelligent parameters: DeepFocus=${canDeepFocus}, FrequentBreaks=${needsFrequentBreaks}, BreakFreq=${breakFrequency}min`);
    
    // Separate tasks by priority and type - FIXED: Use tasksCopy
    const highPriorityTasks = tasksCopy.filter(t => t.priorityScore <= 2).sort((a, b) => a.priorityScore - b.priorityScore);
    const routineTasks = tasksCopy.filter(t => t.routine).sort((a, b) => a.priorityScore - b.priorityScore);
    const regularTasks = tasksCopy.filter(t => !t.routine && t.priorityScore > 2).sort((a, b) => a.priorityScore - b.priorityScore);
    
    console.log(`Task breakdown: ${highPriorityTasks.length} high priority, ${routineTasks.length} routine, ${regularTasks.length} regular`);
    
    // FIXED: Helper function for safe break insertion
    function shouldInsertBreakSafe(currentTime, consecutiveWork, targetEndTime) {
        try {
            // Don't break within first hour of work
            const workStartHour = parseInt(workShift.startTime.split(':')[0]);
            const currentHour = parseInt(currentTime.split(':')[0]);
            if (currentHour <= workStartHour + 1) return false;
            
            // Don't break too close to meal times
            const minutesToEnd = getMinutesBetween(currentTime, targetEndTime);
            if (minutesToEnd <= 30) return false;
            
            // Check if break is needed based on work duration
            return consecutiveWork >= breakFrequency && minutesToEnd >= 45;
        } catch (error) {
            console.error('Error in break logic:', error.message);
            return false;
        }
    }
    
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
    consecutiveWorkMinutes = 30;
    
    // ROUTINE TASKS PHASE (Until 10 AM) - Schedule REAL routine tasks
    const routineEndTime = '10:00';
    let routineLoopSafety = 0;
    while (getMinutesBetween(currentTime, routineEndTime) >= 30 && routineLoopSafety < 10) {
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
            console.log(`✓ Scheduled routine task: ${nextRoutineTask.title} (Priority: ${nextRoutineTask.priority})`);
        } else {
            // No more routine tasks, schedule admin
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
        
        // FIXED: Safe break logic
        if (shouldInsertBreakSafe(currentTime, consecutiveWorkMinutes, routineEndTime)) {
            const breakType = needsFrequentBreaks ? 'Recovery Break' : 'Energy Break';
            schedule.push({
                title: breakType,
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
            console.log(`✓ Inserted ${breakType} (stress/energy management)`);
        }
        routineLoopSafety++;
    }
    currentTime = routineEndTime;
    consecutiveWorkMinutes = 0;
    
    // PEAK FOCUS PHASE (10 AM - 12 PM) - Schedule HIGH PRIORITY TASKS
    const deepWorkEnd = '12:00';
    let focusLoopSafety = 0;
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30 && focusLoopSafety < 10) {
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
            console.log(`✓ Scheduled HIGH PRIORITY task: ${highPriorityTask.title} (Priority: ${highPriorityTask.priority}, Due: ${highPriorityTask.dueDate || 'None'})`);
        } else if (canDeepFocus) {
            // No high priority tasks left, but can still do deep work
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
                // Only create generic deep focus if NO tasks available
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
            // Low energy/focus - assign any available task as admin work
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
                console.log(`✓ Scheduled admin task (low energy): ${anyTask.title}`);
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
        
        // Intensive work break logic
        if (shouldInsertBreakSafe(currentTime, consecutiveWorkMinutes, deepWorkEnd) && 
            consecutiveWorkMinutes >= (canDeepFocus ? 90 : 60)) {
            schedule.push({
                title: 'Focus Recovery Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Focus Recovery Break (intensive work)');
        }
        focusLoopSafety++;
    }
    currentTime = deepWorkEnd;
    
    // LUNCH BREAK - Adjusted based on energy and stress
    const lunchDuration = (isLowEnergy || safeData.stressLevel === 'Maxed Out') ? 75 : 60;
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
    lastBreakTime = currentTime;
    
    // AFTERNOON WORK PHASE (Post-lunch - 16:00) - Remaining tasks based on energy
    const afternoonWorkEnd = '16:00';
    let afternoonLoopSafety = 0;
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30 && afternoonLoopSafety < 15) {
        const remainingTask = assignBestTask([...regularTasks, ...tasksCopy.filter(t => !t.used)], 'Admin');
        
        if (remainingTask) {
            // Determine block type based on task priority and afternoon energy
            const blockType = (remainingTask.priorityScore <= 2 && isMediumEnergy) ? 'Deep Work' : 'Admin';
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: Math.min(30, remainingTask.estimatedTime || 30),
                type: blockType,
                context: 'Work',
                energy: blockType === 'Deep Work' ? 'High' : 'Med',
                taskId: remainingTask.id
            });
            console.log(`✓ Scheduled afternoon task: ${remainingTask.title} as ${blockType}`);
        } else {
            // No more tasks - create contextual work blocks
            try {
                const currentHour = parseInt(currentTime.split(':')[0]);
                if (currentHour === 13 && isMediumEnergy) {
                    schedule.push({
                        title: 'Afternoon Project Focus',
                        start: currentTime,
                        duration: 30,
                        type: 'Admin',
                        context: 'Work',
                        energy: 'Med'
                    });
                } else if (currentHour >= 14 && socialCapable) {
                    schedule.push({
                        title: 'Communications & Meetings',
                        start: currentTime,
                        duration: 30,
                        type: 'Meeting',
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
            } catch (timeError) {
                console.error('Error parsing current time:', timeError.message);
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
        
        // Afternoon break logic - more conservative, based on stress/energy
        if (shouldInsertBreakSafe(currentTime, consecutiveWorkMinutes, afternoonWorkEnd) &&
            (needsFrequentBreaks || consecutiveWorkMinutes >= 90)) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Afternoon Break (energy management)');
        }
        afternoonLoopSafety++;
    }
    currentTime = afternoonWorkEnd;
    
    // END OF DAY PHASE (16:00-17:30) - Light tasks only
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
            try {
                const currentHour = parseInt(currentTime.split(':')[0]);
                const blockTitle = currentHour === 16 ? 'End of Day Admin' : 'Wrap-up & Planning';
                schedule.push({
                    title: blockTitle,
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Low'
                });
            } catch (timeError) {
                schedule.push({
                    title: 'End of Day Wrap-up',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Low'
                });
            }
        }
        currentTime = addMinutes(currentTime, 30);
    }
    currentTime = workShift.endTime || '17:30'; // Fallback
    
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
    
    // Personal wind-down
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Evening personal time
    let eveningLoopSafety = 0;
    while (getMinutesBetween(currentTime, '22:00') >= 30 && eveningLoopSafety < 10) {
        schedule.push({
            title: 'Personal Time',
            start: currentTime,
            duration: 30,
            type: 'Events',
            context: 'Personal',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 30);
        eveningLoopSafety++;
    }
    
    const tasksScheduled = tasksCopy.filter(t => t.used).length;
    console.log(`✅ INTELLIGENT schedule created: ${schedule.length} blocks, ${tasksScheduled}/${allTasks.length} tasks scheduled`);
    console.log(`✅ Used morning log data for: energy-based focus periods, intelligent break frequency, stress-aware scheduling`);
    
    return schedule;
}
                });
                console.log(`✓ Scheduled admin task (low energy): ${anyTask.title}`);
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
        
        // Intensive work break logic
        if (consecutiveWorkMinutes >= (canDeepFocus ? 90 : 60) && 
            getMinutesBetween(currentTime, deepWorkEnd) >= 45) {
            schedule.push({
                title: 'Focus Recovery Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Focus Recovery Break (intensive work)');
        }
    }
    currentTime = deepWorkEnd;
    
    // LUNCH BREAK - Adjusted based on energy and stress
    const lunchDuration = (isLowEnergy || morningData.stressLevel === 'Maxed Out') ? 75 : 60;
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
    lastBreakTime = currentTime;
    
    // AFTERNOON WORK PHASE (Post-lunch - 16:00) - Remaining tasks based on energy
    const afternoonWorkEnd = '16:00';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const remainingTask = assignBestTask([...regularTasks, ...allTasks.filter(t => !t.used)], 'Admin');
        
        if (remainingTask) {
            // Determine block type based on task priority and afternoon energy
            const blockType = (remainingTask.priorityScore <= 2 && isMediumEnergy) ? 'Deep Work' : 'Admin';
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: Math.min(30, remainingTask.estimatedTime),
                type: blockType,
                context: 'Work',
                energy: blockType === 'Deep Work' ? 'High' : 'Med',
                taskId: remainingTask.id
            });
            console.log(`✓ Scheduled afternoon task: ${remainingTask.title} as ${blockType}`);
        } else {
            // No more tasks - create contextual work blocks
            const currentHour = parseInt(currentTime.split(':')[0]);
            if (currentHour === 13 && isMediumEnergy) {
                schedule.push({
                    title: 'Afternoon Project Focus',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            } else if (currentHour >= 14 && socialCapable) {
                schedule.push({
                    title: 'Communications & Meetings',
                    start: currentTime,
                    duration: 30,
                    type: 'Meeting',
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
        
        // Afternoon break logic - more conservative, based on stress/energy
        if (consecutiveWorkMinutes >= breakFrequency && 
            getMinutesBetween(currentTime, afternoonWorkEnd) >= 45 &&
            (needsFrequentBreaks || consecutiveWorkMinutes >= 90)) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
            console.log('✓ Inserted Afternoon Break (energy management)');
        }
    }
    currentTime = afternoonWorkEnd;
    
    // END OF DAY PHASE (16:00-17:30) - Light tasks only
    while (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
        const lightTask = assignBestTask(allTasks.filter(t => !t.used && t.priorityScore >= 4), 'Admin');
        
        if (lightTask) {
            schedule.push({
                title: lightTask.title,
                start: currentTime,
                duration: Math.min(30, lightTask.estimatedTime),
                type: 'Admin',
                context: 'Work',
                energy: 'Low',
                taskId: lightTask.id
            });
            console.log(`✓ Scheduled end-of-day task: ${lightTask.title}`);
        } else {
            const currentHour = parseInt(currentTime.split(':')[0]);
            const blockTitle = currentHour === 16 ? 'End of Day Admin' : 'Wrap-up & Planning';
            schedule.push({
                title: blockTitle,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Low'
            });
        }
        currentTime = addMinutes(currentTime, 30);
    }
    currentTime = workShift.endTime;
    
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
    
    // Personal wind-down
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Evening personal time
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
    
    const tasksScheduled = allTasks.filter(t => t.used).length;
    console.log(`✅ INTELLIGENT schedule created: ${schedule.length} blocks, ${tasksScheduled}/${allTasks.length} tasks scheduled`);
    console.log(`✅ Used morning log data for: energy-based focus periods, intelligent break frequency, stress-aware scheduling`);
    
    return schedule;
}.filter(t => t.priorityScore >= 4), 'Admin');
        
        if (lightTask) {
            schedule.push({
                title: lightTask.title,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Low',
                taskId: lightTask.id
            });
            console.log(`Scheduled end-of-day task: ${lightTask.title}`);
        } else {
            const currentHour = parseInt(currentTime.split(':')[0]);
            const blockTitle = currentHour === 16 ? 'End of Day Admin' : 'Wrap-up & Planning';
            schedule.push({
                title: blockTitle,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Low'
            });
        }
        currentTime = addMinutes(currentTime, 30);
    }
    currentTime = workShift.endTime;
    
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
    
    // Personal wind-down
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Evening personal time
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
    
    const tasksScheduled = allTasks.filter(t => t.used).length;
    console.log(`Created intelligent schedule with ${schedule.length} blocks, scheduled ${tasksScheduled}/${allTasks.length} tasks`);
    
    return schedule;
}

// FIXED: Home day schedule with proper task assignment
function createHomeDaySchedule(wakeTime, allTasks, energy, focusCapacity) {
    console.log('Creating home day schedule with intelligent task integration');
    console.log(`Available tasks: ${allTasks.length} total`);
    
    let schedule = [];
    let currentTime = wakeTime;
    let consecutiveWorkMinutes = 0;
    let lastBreakTime = null;
    
    // Separate tasks
    const routineTasks = allTasks.filter(t => t.routine);
    const projectTasks = allTasks.filter(t => !t.routine);
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine & Recovery',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Morning planning
    schedule.push({
        title: 'Morning Planning & Setup',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 30);
    consecutiveWorkMinutes = 30;
    
    // Routine tasks (must complete by 10 AM)
    const routineEndTime = '10:00';
    while (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const routineTask = assignBestTask(routineTasks, 'Routine');
        
        if (routineTask) {
            schedule.push({
                title: routineTask.title,
                start: currentTime,
                duration: 30,
                type: 'Routine',
                context: 'Work',
                energy: 'Medium',
                taskId: routineTask.id
            });
            console.log(`Scheduled routine task: ${routineTask.title}`);
        } else {
            schedule.push({
                title: 'Morning Admin Tasks',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Personal',
                energy: 'Medium'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        // Smart break for home days
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, wakeTime, '12:00') && 
            getMinutesBetween(currentTime, routineEndTime) >= 45) {
            schedule.push({
                title: 'Morning Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
        }
    }
    currentTime = routineEndTime;
    consecutiveWorkMinutes = 0;
    
    // Deep work blocks based on energy (10 AM - 12 PM)
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        if (energy >= 7 && focusCapacity === 'Sharp') {
            const highPriorityTask = assignBestTask(allTasks, 'Deep Work');
            if (highPriorityTask) {
                schedule.push({
                    title: highPriorityTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: highPriorityTask.id
                });
                console.log(`Scheduled deep work task: ${highPriorityTask.title}`);
            } else {
                schedule.push({
                    title: 'Deep Focus Session',
                    start: currentTime,
                    duration: 30,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High'
                });
            }
            consecutiveWorkMinutes += 30;
        } else {
            const anyTask = assignBestTask(allTasks, 'Admin');
            if (anyTask) {
                schedule.push({
                    title: anyTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Medium',
                    taskId: anyTask.id
                });
                console.log(`Scheduled admin task: ${anyTask.title}`);
            } else {
                schedule.push({
                    title: 'Project Work',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Medium'
                });
            }
            consecutiveWorkMinutes += 30;
        }
        
        currentTime = addMinutes(currentTime, 30);
        
        // Smart break for home days
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, wakeTime, '12:00') && 
            getMinutesBetween(currentTime, deepWorkEnd) >= 45) {
            schedule.push({
                title: 'Focus Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
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
    lastBreakTime = currentTime; // Lunch counts as break
    
    // Afternoon work (13:00 - 15:30)
    const afternoonWorkEnd = '15:30';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const remainingTask = assignBestTask(allTasks, 'Admin');
        
        if (remainingTask) {
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Medium',
                taskId: remainingTask.id
            });
            console.log(`Scheduled afternoon task: ${remainingTask.title}`);
        } else {
            schedule.push({
                title: 'Afternoon Project Work',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Medium'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        // Afternoon break logic
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, wakeTime, null) && 
            getMinutesBetween(currentTime, afternoonWorkEnd) >= 45) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            lastBreakTime = currentTime;
            consecutiveWorkMinutes = 0;
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
        energy: 'Medium'
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
    
    // Personal wind-down
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Evening personal time
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
    
    const tasksScheduled = allTasks.filter(t => t.used).length;
    console.log(`Created home day schedule with ${schedule.length} blocks, scheduled ${tasksScheduled}/${allTasks.length} tasks`);
    
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

// FIXED: Create time blocks with proper task relations
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`Creating ${schedule.length} time blocks with task relations...`);
    
    const results = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            const properties = {
                Title: { title: [{ text: { content: block.title } }] },
                Type: { select: { name: block.type } },
                Context: { select: { name: block.context } },
                'Energy Requirements': { select: { name: block.energy } },
                Status: { select: { name: 'Active' } },
                'Start Time': { date: { start: startUTC } },
                'End Time': { date: { start: endUTC } },
                'Auto-Filled': { checkbox: true }
            };
            
            // FIXED: Link task to time block if taskId exists
            if (block.taskId) {
                properties['Tasks'] = { relation: [{ id: block.taskId }] };
                console.log(`Linking task ${block.taskId} to time block "${block.title}"`);
            }
            
            if (dailyLogId) {
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
                taskId: block.taskId || null,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`Failed to create block "${block.title}":`, error.message);
            results.push({
                title: block.title,
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

// FIXED: Main workflow with comprehensive error handling and input validation
async function runEnhancedScheduler(today) {
    console.log('Starting FIXED enhanced scheduler workflow...');
    
    // FIXED: Input validation
    if (!today || typeof today !== 'string') {
        throw new Error('Invalid today parameter - must be a valid date string');
    }
    
    // FIXED: Initialize global result to prevent undefined access
    if (typeof global === 'undefined') {
        globalThis.lastCreationResult = null;
    } else {
        global.lastCreationResult = null;
    }
    
    try {
        // Step 1: Clear existing blocks
        console.log('Step 1: Clearing existing blocks...');
        await clearAutoFilledBlocks(today);
        
        // Step 2: Get morning log with input validation
        console.log('Step 2: Getting morning log...');
        const morningData = await getEnhancedMorningLog(today);
        if (!morningData) {
            throw new Error('Failed to get morning log data');
        }
        
        // Step 3: Check work schedule with validation
        console.log('Step 3: Checking work schedule...');
        const workShift = await getWorkShift(today);
        if (!workShift) {
            throw new Error('Failed to get work shift data');
        }
        
        // Step 4: Get tasks with correct property mapping
        console.log('Step 4: Fetching tasks with CORRECT property names...');
        const allTasks = await getTodaysTasks(today);
        
        if (!Array.isArray(allTasks)) {
            console.error('getTodaysTasks returned invalid data:', typeof allTasks);
            throw new Error('Task fetching returned invalid data');
        }
        
        console.log(`Successfully fetched ${allTasks.length} tasks for intelligent scheduling`);
        
        // Step 5: Generate intelligent schedule with validation
        console.log('Step 5: Generating intelligent schedule using REAL morning log data...');
        let schedule;
        
        if (workShift.isWorkDay) {
            console.log('Creating INTELLIGENT work day schedule...');
            schedule = createWorkDaySchedule(
                morningData.wakeTime, 
                workShift, 
                allTasks,
                morningData // Pass entire morning data object
            );
        } else {
            console.log('Creating INTELLIGENT home day schedule...');
            schedule = createHomeDaySchedule(
                morningData.wakeTime, 
                allTasks,
                morningData // Pass entire morning data object
            );
        }
        
        // FIXED: Validate schedule was created properly
        if (!Array.isArray(schedule) || schedule.length === 0) {
            throw new Error('Schedule generation failed - no blocks created');
        }
        
        console.log(`Generated schedule with ${schedule.length} blocks`);
        
        // Step 6: Create blocks in Notion with task relations
        console.log('Step 6: Creating time blocks in Notion...');
        const dailyLogId = await getDailyLogId(today);
        const createdBlocks = await createTimeBlocks(schedule, today, dailyLogId);
        
        // FIXED: Validate block creation results
        if (!Array.isArray(createdBlocks)) {
            throw new Error('Block creation returned invalid results');
        }
        
        // Count task assignments
        const tasksScheduled = createdBlocks.filter(b => b && b.taskId).length;
        const successfulBlocks = createdBlocks.filter(b => b && b.status === 'created').length;
        const failedBlocks = createdBlocks.filter(b => b && b.status === 'failed').length;
        
        // FIXED: Set results with better error handling
        const resultData = {
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
        
        // Set global result safely
        if (typeof global !== 'undefined') {
            global.lastCreationResult = resultData;
        } else {
            globalThis.lastCreationResult = resultData;
        }
        
        console.log(`FIXED scheduler completed: ${successfulBlocks} blocks created, ${tasksScheduled} tasks scheduled, ${failedBlocks} failed`);
        
        return {
            created: createdBlocks,
            morningData: morningData,
            workShift: workShift,
            tasksFound: allTasks.length,
            tasksScheduled: tasksScheduled,
            summary: resultData
        };
        
    } catch (error) {
        console.error('Critical failure in FIXED scheduler:', error.message);
        console.error('Error stack:', error.stack);
        
        // FIXED: Set error result safely
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

                // Convert UTC stored times back to Pacific for display
                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                // Check if block is from today Pacific time
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
