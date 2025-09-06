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

// ENHANCED: Get today's tasks with Fixed Time scheduling support
async function getTodaysTasks(today) {
    try {
        if (!today || typeof today !== 'string') {
            console.error('Invalid today parameter:', today);
            return { flexibleTasks: [], fixedTimeTasks: [] };
        }
        
        console.log('🔍 Querying tasks database with FIXED TIME scheduling support...');
        
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
                            },
                            {
                                property: 'Fixed Time',
                                date: { is_not_empty: true }
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
                { property: 'Fixed Time', direction: 'ascending' },
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 100
        });

        console.log(`📋 Found ${tasksResponse.results.length} total tasks in database`);

        const flexibleTasks = [];
        const fixedTimeTasks = [];

        tasksResponse.results.forEach(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn('⚠️ Skipping task with empty title:', task.id);
                    return;
                }
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || 'Admin';
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                const fixedTime = props['Fixed Time']?.date?.start;
                const scheduleToday = props['Schedule Today?']?.checkbox || false;
                
                // Calculate priority score (lower = higher priority)
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
                }
                
                // Urgency boost for overdue/due today tasks
                if (dueDate) {
                    try {
                        const dueDateTime = new Date(dueDate);
                        const todayDateTime = new Date(today);
                        const dueDays = Math.ceil((dueDateTime - todayDateTime) / (1000 * 60 * 60 * 24));
                        
                        if (dueDays <= 0) priorityScore = Math.max(1, priorityScore - 2); // Overdue
                        else if (dueDays <= 1) priorityScore = Math.max(1, priorityScore - 1); // Due today/tomorrow
                    } catch (dateError) {
                        console.warn(`⚠️ Error parsing due date for task ${title}:`, dateError.message);
                    }
                }
                
                const taskData = {
                    title: title.trim(),
                    priority,
                    priorityScore,
                    type: type?.toLowerCase() || 'admin',
                    estimatedTime: Math.max(15, estimatedTime || 30),
                    dueDate,
                    fixedTime,
                    scheduleToday,
                    id: task.id,
                    used: false
                };
                
                // CRITICAL: Separate fixed-time from flexible tasks
                if (fixedTime) {
                    const fixedTimePacific = utcToPacificTime(fixedTime);
                    taskData.scheduledTime = fixedTimePacific;
                    fixedTimeTasks.push(taskData);
                    console.log(`📅 FIXED TIME TASK: "${title}" at ${fixedTimePacific}`);
                } else {
                    flexibleTasks.push(taskData);
                }
                
            } catch (taskError) {
                console.error('❌ Error processing individual task:', taskError.message);
            }
        });
        
        console.log(`✅ Task categorization complete:`);
        console.log(`   📅 Fixed Time Tasks: ${fixedTimeTasks.length}`);
        console.log(`   🔄 Flexible Tasks: ${flexibleTasks.length}`);
        
        return { flexibleTasks, fixedTimeTasks };
        
    } catch (error) {
        console.error('❌ Error getting tasks:', error.message);
        console.error('Full error details:', error);
        return { flexibleTasks: [], fixedTimeTasks: [] };
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

function timeStringToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

function minutesToTimeString(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

// ENHANCED: Smart task assignment with type matching
function assignBestTask(availableTasks, blockType, blockDuration = 30) {
    if (!availableTasks || !Array.isArray(availableTasks) || availableTasks.length === 0) {
        return null;
    }
    
    const unusedTasks = availableTasks.filter(t => t && !t.used && t.title);
    if (unusedTasks.length === 0) {
        return null;
    }
    
    // TYPE MATCHING: Match task types to appropriate block types
    let compatibleTasks = unusedTasks;
    
    if (blockType === 'Deep Work') {
        // Deep Work blocks prefer: Deep Work tasks, then Creative, then high-priority Admin
        compatibleTasks = unusedTasks.filter(t => 
            t.type === 'deep work' || 
            t.type === 'creative' || 
            (t.type === 'admin' && t.priorityScore <= 2)
        );
        if (compatibleTasks.length === 0) compatibleTasks = unusedTasks;
    } else if (blockType === 'Admin') {
        // Admin blocks prefer: Admin tasks, then Errands, then lower priority items
        compatibleTasks = unusedTasks.filter(t => 
            t.type === 'admin' || 
            t.type === 'errand'
        );
        if (compatibleTasks.length === 0) compatibleTasks = unusedTasks;
    } else if (blockType === 'Routine') {
        // Routine blocks strongly prefer routine tasks
        compatibleTasks = unusedTasks.filter(t => t.priority === 'Routine');
        if (compatibleTasks.length === 0) {
            compatibleTasks = unusedTasks.filter(t => t.type === 'admin' && t.priorityScore >= 3);
        }
        if (compatibleTasks.length === 0) compatibleTasks = unusedTasks;
    }
    
    // DURATION MATCHING: Prefer tasks that fit the block duration
    const appropriateDurationTasks = compatibleTasks.filter(t => 
        t.estimatedTime <= blockDuration * 1.2 && t.estimatedTime >= blockDuration * 0.5
    );
    
    const candidateTasks = appropriateDurationTasks.length > 0 ? appropriateDurationTasks : compatibleTasks;
    
    // PRIORITY SELECTION: Sort by priority score (lower = higher priority)
    const selectedTask = candidateTasks.sort((a, b) => {
        if (a.priorityScore !== b.priorityScore) {
            return a.priorityScore - b.priorityScore;
        }
        // If same priority, prefer tasks due sooner
        if (a.dueDate && b.dueDate) {
            return new Date(a.dueDate) - new Date(b.dueDate);
        }
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        return 0;
    })[0];
    
    if (selectedTask) {
        selectedTask.used = true;
        console.log(`✅ Assigned "${selectedTask.title}" (${selectedTask.priority}/${selectedTask.type}) to ${blockType} block`);
    }
    
    return selectedTask;
}

// Work shift detection
async function getWorkShift(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, assuming home day');
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
            console.log(`🏭 Found ${workEvents.data.items.length} work site events - at site`);
            return {
                isWorkDay: true,
                isAtSite: true,
                startTime: '05:30',
                endTime: '17:30',
                title: 'Site Work Day'
            };
        } else {
            console.log('🏠 No work site events found - home day');
            return {
                isWorkDay: false,
                isAtSite: false,
                startTime: '09:00',
                endTime: '17:00',
                title: 'Home Day'
            };
        }
        
    } catch (error) {
        console.error('❌ Error checking work site calendar:', error.message);
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
        console.log('🌅 Getting today\'s morning log for intelligent scheduling...');
        const morningLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        if (morningLogResponse.results.length === 0) {
            console.log('⚠️ No morning log found for today, using defaults');
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
        
        console.log('✅ Parsed comprehensive morning log:', {
            energy: data.energy,
            mood: data.mood,
            focus: data.focusCapacity,
            sleepQuality: data.sleepQuality
        });
        
        return data;
        
    } catch (error) {
        console.error('❌ Error fetching morning log:', error.message);
        return defaultData;
    }
}

// ENHANCED: Create schedule with Fixed Time task placement
function createEnhancedSchedule(wakeTime, workShift, tasks, morningData) {
    const { flexibleTasks, fixedTimeTasks } = tasks;
    
    console.log(`🧠 Creating ENHANCED schedule with ${fixedTimeTasks.length} fixed-time and ${flexibleTasks.length} flexible tasks`);
    
    let schedule = [];
    let currentTime = wakeTime;
    
    // Copy flexible tasks for assignment
    const availableTasks = flexibleTasks.map(t => ({...t, used: false}));
    
    // Energy and focus parameters
    const energyLevel = Math.max(1, Math.min(10, morningData.energy || 7));
    const canDeepFocus = morningData.focusCapacity === 'Sharp' && energyLevel >= 7;
    const needsFrequentBreaks = morningData.stressLevel === 'Maxed Out' || 
                                morningData.bodyStatus === 'Tired' || 
                                morningData.sleepHours < 6;
    
    const breakFrequency = needsFrequentBreaks ? 60 : (energyLevel < 6 ? 75 : 90);
    
    console.log(`⚡ Energy level: ${energyLevel}/10, Deep focus: ${canDeepFocus}, Break frequency: ${breakFrequency}min`);
    
    // PHASE 1: Morning Routine
    schedule.push({
        title: workShift.isAtSite ? 'Morning Routine (Work Camp)' : 'Morning Routine & Coffee',
        start: currentTime,
        duration: workShift.isAtSite ? 30 : 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, workShift.isAtSite ? 30 : 60);
    
    // Morning planning
    schedule.push({
        title: 'Morning Planning & Priority Review',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: workShift.isAtSite ? 'Work' : 'Personal',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 30);
    
    let consecutiveWorkMinutes = 30;
    
    // PHASE 2: Routine Tasks (until 10:00 AM)
    const routineEndTime = '10:00';
    while (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        // Check for fixed-time tasks in this slot
        const fixedTask = fixedTimeTasks.find(ft => {
            const fixedMinutes = timeStringToMinutes(ft.scheduledTime);
            const currentMinutes = timeStringToMinutes(currentTime);
            return Math.abs(fixedMinutes - currentMinutes) <= 15; // 15-minute tolerance
        });
        
        if (fixedTask) {
            schedule.push({
                title: `${fixedTask.title} (SCHEDULED)`,
                start: fixedTask.scheduledTime,
                duration: fixedTask.estimatedTime,
                type: fixedTask.type === 'meeting' ? 'Meeting' : 'Admin',
                context: 'Work',
                energy: 'Med',
                taskId: fixedTask.id,
                isFixedTime: true
            });
            currentTime = addMinutes(fixedTask.scheduledTime, fixedTask.estimatedTime);
            console.log(`📅 PLACED FIXED TIME TASK: "${fixedTask.title}" at ${fixedTask.scheduledTime}`);
        } else {
            const routineTask = assignBestTask(availableTasks, 'Routine', 30);
            if (routineTask) {
                schedule.push({
                    title: routineTask.title,
                    start: currentTime,
                    duration: Math.min(30, routineTask.estimatedTime),
                    type: 'Routine',
                    context: 'Work',
                    energy: 'Med',
                    taskId: routineTask.id
                });
            } else {
                schedule.push({
                    title: 'Morning Admin & Setup',
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
            currentTime = addMinutes(currentTime, 30);
        }
        
        consecutiveWorkMinutes += 30;
        
        // Insert breaks if needed
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
        }
    }
    
    currentTime = routineEndTime;
    consecutiveWorkMinutes = 0;
    
    // PHASE 3: Peak Focus Work (10:00 AM - 12:00 PM)
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        // Check for fixed-time tasks
        const fixedTask = fixedTimeTasks.find(ft => {
            const fixedMinutes = timeStringToMinutes(ft.scheduledTime);
            const currentMinutes = timeStringToMinutes(currentTime);
            return Math.abs(fixedMinutes - currentMinutes) <= 15;
        });
        
        if (fixedTask) {
            schedule.push({
                title: `${fixedTask.title} (SCHEDULED)`,
                start: fixedTask.scheduledTime,
                duration: fixedTask.estimatedTime,
                type: fixedTask.type === 'meeting' ? 'Meeting' : 'Deep Work',
                context: 'Work',
                energy: 'High',
                taskId: fixedTask.id,
                isFixedTime: true
            });
            currentTime = addMinutes(fixedTask.scheduledTime, fixedTask.estimatedTime);
            console.log(`📅 PLACED FIXED TIME TASK: "${fixedTask.title}" at ${fixedTask.scheduledTime}`);
        } else if (canDeepFocus) {
            const deepWorkTask = assignBestTask(availableTasks, 'Deep Work', 30);
            if (deepWorkTask) {
                schedule.push({
                    title: deepWorkTask.title,
                    start: currentTime,
                    duration: Math.min(60, deepWorkTask.estimatedTime),
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: deepWorkTask.id
                });
                currentTime = addMinutes(currentTime, Math.min(60, deepWorkTask.estimatedTime));
            } else {
                schedule.push({
                    title: 'Deep Focus Session',
                    start: currentTime,
                    duration: 60,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High'
                });
                currentTime = addMinutes(currentTime, 60);
            }
            consecutiveWorkMinutes += 60;
        } else {
            const adminTask = assignBestTask(availableTasks, 'Admin', 30);
            if (adminTask) {
                schedule.push({
                    title: adminTask.title,
                    start: currentTime,
                    duration: Math.min(30, adminTask.estimatedTime),
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med',
                    taskId: adminTask.id
                });
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
            currentTime = addMinutes(currentTime, 30);
            consecutiveWorkMinutes += 30;
        }
        
        // Insert focus breaks if needed
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
        }
    }
    
    currentTime = deepWorkEnd;
    
    // PHASE 4: Lunch Break
    const lunchDuration = (energyLevel <= 5 || morningData.stressLevel === 'Maxed Out') ? 75 : 60;
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
    
    // PHASE 5: Afternoon Work (Post-lunch until 16:00)
    const afternoonWorkEnd = workShift.isAtSite ? '16:00' : '15:30';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        // Check for fixed-time tasks first
        const fixedTask = fixedTimeTasks.find(ft => {
            const fixedMinutes = timeStringToMinutes(ft.scheduledTime);
            const currentMinutes = timeStringToMinutes(currentTime);
            return Math.abs(fixedMinutes - currentMinutes) <= 15;
        });
        
        if (fixedTask) {
            schedule.push({
                title: `${fixedTask.title} (SCHEDULED)`,
                start: fixedTask.scheduledTime,
                duration: fixedTask.estimatedTime,
                type: fixedTask.type === 'meeting' ? 'Meeting' : 'Admin',
                context: 'Work',
                energy: 'Med',
                taskId: fixedTask.id,
                isFixedTime: true
            });
            currentTime = addMinutes(fixedTask.scheduledTime, fixedTask.estimatedTime);
            console.log(`📅 PLACED FIXED TIME TASK: "${fixedTask.title}" at ${fixedTask.scheduledTime}`);
        } else {
            const remainingTask = assignBestTask(availableTasks, 'Admin', 30);
            if (remainingTask) {
                const blockType = (remainingTask.priorityScore <= 2 && energyLevel >= 6) ? 'Deep Work' : 'Admin';
                schedule.push({
                    title: remainingTask.title,
                    start: currentTime,
                    duration: Math.min(30, remainingTask.estimatedTime),
                    type: blockType,
                    context: 'Work',
                    energy: blockType === 'Deep Work' ? 'High' : 'Med',
                    taskId: remainingTask.id
                });
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
        }
        
        consecutiveWorkMinutes += 30;
        
        // Insert afternoon breaks if needed
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, afternoonWorkEnd) >= 45) {
            schedule.push({
                title: 'Afternoon Energy Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
        }
    }
    
    currentTime = afternoonWorkEnd;
    
    // PHASE 6: End of Work Day / Family Time
    if (!workShift.isAtSite) {
        // Home day: Riley time
        schedule.push({
            title: 'Riley Time (After School)',
            start: currentTime,
            duration: 120,
            type: 'Events',
            context: 'Family',
            energy: 'Med'
        });
        currentTime = addMinutes(currentTime, 120);
        
        // Dinner
        schedule.push({
            title: 'Dinner & Family Time',
            start: currentTime,
            duration: 90,
            type: 'Events',
            context: 'Family',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 90);
    } else {
        // Work site day: wrap up and travel
        while (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
            const lightTask = assignBestTask(availableTasks.filter(t => !t.used && t.priorityScore >= 4), 'Admin', 30);
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
    }
    
    // PHASE 7: Evening routine
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
    
    // Fill remaining evening with personal time
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
    
    // SUMMARY STATISTICS
    const tasksScheduled = availableTasks.filter(t => t.used).length;
    const fixedTasksScheduled = fixedTimeTasks.length;
    const totalTasksScheduled = tasksScheduled + fixedTasksScheduled;
    
    console.log(`✅ ENHANCED schedule created:`);
    console.log(`   📋 Total blocks: ${schedule.length}`);
    console.log(`   📅 Fixed-time tasks scheduled: ${fixedTasksScheduled}`);
    console.log(`   🔄 Flexible tasks scheduled: ${tasksScheduled}/${flexibleTasks.length}`);
    console.log(`   🎯 Total task coverage: ${totalTasksScheduled}/${flexibleTasks.length + fixedTimeTasks.length}`);
    
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
        
        console.log(`🗑️ Cleared ${existing.results.length} existing blocks`);
    } catch (error) {
        console.error('❌ Error clearing blocks:', error.message);
    }
}

// ENHANCED: Create time blocks with proper task relations and Fixed Time handling
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`🏗️ Creating ${schedule.length} time blocks with enhanced task relations...`);
    
    const results = [];
    
    const energyMapping = {
        'Low': 'Low',
        'Medium': 'Med',
        'High': 'High'
    };
    
    for (const block of schedule) {
        try {
            if (!block || !block.title || !block.start || !block.duration) {
                console.warn('⚠️ Skipping invalid block:', block);
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
            
            // ENHANCED: Link tasks with proper validation
            if (block.taskId && typeof block.taskId === 'string') {
                properties['Tasks'] = { relation: [{ id: block.taskId }] };
                const fixedTimeIndicator = block.isFixedTime ? ' [FIXED TIME]' : '';
                console.log(`🔗 Linking task ${block.taskId} to time block "${block.title}"${fixedTimeIndicator}`);
            }
            
            if (dailyLogId && typeof dailyLogId === 'string') {
                properties['Daily Logs'] = { relation: [{ id: dailyLogId }] };
            }
            
            // Add notes for special blocks
            if (block.isFixedTime) {
                properties['Notes'] = { 
                    rich_text: [{ text: { content: 'Scheduled at fixed time from task Fixed Time property' } }] 
                };
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
                isFixedTime: block.isFixedTime || false,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create block "${block?.title || 'Unknown'}":`, error.message);
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
        console.error('❌ Error getting daily log ID:', error.message);
        return null;
    }
}

// MAIN ENHANCED WORKFLOW
async function runEnhancedScheduler(today) {
    console.log('🚀 Starting ENHANCED scheduler with Fixed Time & Priority Intelligence...');
    
    if (!today || typeof today !== 'string') {
        throw new Error('Invalid today parameter - must be a valid date string');
    }
    
    let lastCreationResult = null;
    
    try {
        await clearAutoFilledBlocks(today);
        
        console.log('📊 Gathering comprehensive data...');
        const morningData = await getEnhancedMorningLog(today);
        const workShift = await getWorkShift(today);
        const tasks = await getTodaysTasks(today);
        
        if (!tasks || (!tasks.flexibleTasks && !tasks.fixedTimeTasks)) {
            throw new Error('Failed to get task data');
        }
        
        console.log('🧠 Generating INTELLIGENT schedule with Fixed Time placement...');
        const schedule = createEnhancedSchedule(
            morningData.wakeTime, 
            workShift, 
            tasks,
            morningData
        );
        
        if (!Array.isArray(schedule) || schedule.length === 0) {
            throw new Error('Schedule generation failed - no blocks created');
        }
        
        console.log('💾 Creating time blocks in Notion...');
        const dailyLogId = await getDailyLogId(today);
        const createdBlocks = await createTimeBlocks(schedule, today, dailyLogId);
        
        const tasksScheduled = createdBlocks.filter(b => b && b.taskId).length;
        const fixedTimeBlocks = createdBlocks.filter(b => b && b.isFixedTime).length;
        const successfulBlocks = createdBlocks.filter(b => b && b.status === 'created').length;
        const failedBlocks = createdBlocks.filter(b => b && b.status === 'failed').length;
        
        lastCreationResult = {
            success: successfulBlocks,
            failed: failedBlocks,
            tasksScheduled: tasksScheduled,
            fixedTimeBlocks: fixedTimeBlocks,
            totalFlexibleTasks: tasks.flexibleTasks.length,
            totalFixedTasks: tasks.fixedTimeTasks.length,
            wakeTime: morningData.wakeTime,
            workDay: workShift.isWorkDay,
            energy: morningData.energy,
            focus: morningData.focusCapacity,
            timestamp: new Date().toISOString()
        };
        
        // Store globally for retrieval
        if (typeof global !== 'undefined') {
            global.lastCreationResult = lastCreationResult;
        } else {
            globalThis.lastCreationResult = lastCreationResult;
        }
        
        console.log(`✅ ENHANCED scheduler completed:`);
        console.log(`   📋 ${successfulBlocks} blocks created, ${failedBlocks} failed`);
        console.log(`   📅 ${fixedTimeBlocks} fixed-time tasks placed`);
        console.log(`   🔄 ${tasksScheduled - fixedTimeBlocks} flexible tasks scheduled`);
        
        return {
            created: createdBlocks,
            morningData: morningData,
            workShift: workShift,
            tasksFound: tasks.flexibleTasks.length + tasks.fixedTimeTasks.length,
            tasksScheduled: tasksScheduled,
            fixedTimeTasksPlaced: fixedTimeBlocks,
            summary: lastCreationResult
        };
        
    } catch (error) {
        console.error('💥 Critical failure in ENHANCED scheduler:', error.message);
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
        
        console.log(`📅 Getting schedule for ${today} Pacific`);
        
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

        console.log(`📋 Found ${timeBlocks.results.length} blocks in Notion for ${today}`);

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
                    details: `${context} • ${type}${hasTask ? ' • Task Linked' : ''}${autoFilled ? ' • AI Enhanced' : ''}`
                };
            } catch (error) {
                console.error('❌ Error processing schedule block:', error.message);
                return null;
            }
        }).filter(block => block !== null);

        console.log(`✅ Returning ${schedule.length} formatted blocks for today`);
        return schedule;

    } catch (error) {
        console.error('❌ Failed to get current schedule:', error.message);
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
        console.log('🚀 ENHANCED Scheduler v5.0 - Fixed Time Intelligence + Priority Optimization');
        
        if (!process.env.NOTION_TOKEN) {
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing NOTION_TOKEN'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        
        console.log(`🎯 Processing request: action=${action}, date=${today}`);
        
        if (action === 'create') {
            console.log('⚡ Running ENHANCED scheduler with Fixed Time & Priority Intelligence...');
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
                version: '5.0-Enhanced-Fixed-Time-Priority',
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

        console.log(`✅ ENHANCED request completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('💥 ENHANCED Scheduler Error:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({ 
            error: 'ENHANCED scheduler failed',
            details: error.message,
            stack: error.stack,
            meta: {
                version: '5.0-Enhanced-Fixed-Time-Priority',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};
