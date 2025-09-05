const { Client } = require('@notionhq/client');

// Initialize Notion client
let notion;
try {
    notion = new Client({ auth: process.env.NOTION_TOKEN });
} catch (error) {
    console.error('Failed to initialize Notion client:', error.message);
    throw new Error('NOTION_TOKEN is required');
}

// Database IDs
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
const CONTEXT_TYPE_TO_CALENDAR_ID = {
    "Personal-Events": "shamilarae@gmail.com",
    "Personal-Admin": "ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com",
    "Personal-Appointment": "0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com",
    "Family-Events": "family13053487624784455294@group.calendar.google.com",
    "Work-Travel": "oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com",
    "Work-Admin": "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    "Work-Deep Work": "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    "Work-Meeting": "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    "Work-Routine": "a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com"
};

const ALL_CALENDAR_IDS = Object.values(CONTEXT_TYPE_TO_CALENDAR_ID);
const WORK_SITE_CALENDAR_ID = 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com';

// CRITICAL: Define all functions at module level to ensure proper hoisting

// Get today's tasks - DEFINED FIRST TO AVOID SCOPE ISSUES
async function getTodaysTasks(today) {
    try {
        console.log('Querying tasks database...');
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
            
            const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
            
            return {
                title,
                priority,
                type: type.toLowerCase(),
                routine,
                estimatedTime: Math.max(30, estimatedTime),
                id: task.id
            };
        });
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        return [];
    }
}

// Timezone utilities
function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        const pacificDateTime = `${pacificDateStr}T${pacificTimeStr}:00`;
        const localDate = new Date(pacificDateTime);
        const utcDate = new Date(localDate.getTime() + (7 * 60 * 60 * 1000));
        return utcDate.toISOString();
    } catch (error) {
        console.error('Error in pacificTimeToUTC:', error.message);
        return new Date(`${pacificDateStr}T${pacificTimeStr}:00.000Z`).toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const utcDate = new Date(utcDateStr);
        const pacificDate = new Date(utcDate.getTime() - (7 * 60 * 60 * 1000));
        
        const hours = pacificDate.getUTCHours();
        const minutes = pacificDate.getUTCMinutes();
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
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

function timeToMinutes(timeStr) {
    const [hours, mins] = timeStr.split(':').map(Number);
    return hours * 60 + mins;
}

function minutesToTime(minutes) {
    const hours = Math.floor(minutes / 60) % 24;
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

// Task scheduling functions
function createTaskBlocks(tasks, availableTime, blockType) {
    const blocks = [];
    let currentTime = availableTime.start;
    const endTime = availableTime.end;
    
    let taskIndex = 0;
    
    while (getMinutesBetween(currentTime, endTime) >= 30 && taskIndex < tasks.length) {
        const task = tasks[taskIndex];
        const blockDuration = 30;
        
        blocks.push({
            title: task.title,
            start: currentTime,
            duration: blockDuration,
            type: blockType,
            context: 'Work',
            energy: task.priority === 'High' ? 'High' : 'Medium',
            taskId: task.id
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
        taskIndex++;
        
        // Add break after deep work blocks
        if (blockType === 'Deep Work' && getMinutesBetween(currentTime, endTime) >= 45) {
            blocks.push({
                title: 'Focus Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                isBreak: true
            });
            currentTime = addMinutes(currentTime, 15);
        }
    }
    
    return blocks;
}

function createStandardBlocks(startTime, endTime, blockType, context) {
    const blocks = [];
    let currentTime = startTime;
    
    while (getMinutesBetween(currentTime, endTime) >= 30) {
        const remainingMinutes = getMinutesBetween(currentTime, endTime);
        const blockDuration = Math.min(30, remainingMinutes);
        
        let title;
        if (blockType === 'Admin') {
            title = 'Admin & Communications';
        } else if (blockType === 'Events') {
            title = 'Personal Time';
        } else {
            title = `${blockType} Block`;
        }
        
        blocks.push({
            title: title,
            start: currentTime,
            duration: blockDuration,
            type: blockType,
            context: context || 'Work',
            energy: blockType === 'Deep Work' ? 'High' : 'Medium'
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
    }
    
    return blocks;
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

// Schedule creation functions - FIXED LOGIC
function createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity, allTasks) {
    console.log('Creating work day schedule with proper block variety');
    
    let schedule = [];
    let currentTime = wakeTime;
    
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
    
    // Morning planning - SINGLE BLOCK
    schedule.push({
        title: 'Morning Planning & Setup',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: 'Work',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // ROUTINE TASKS ONLY (must complete by 10 AM) - NOT endless admin
    const morningAdminEnd = '10:00';
    if (routineTasks.length > 0 && getMinutesBetween(currentTime, morningAdminEnd) >= 30) {
        const routineBlocks = createTaskBlocks(
            routineTasks, 
            { start: currentTime, end: morningAdminEnd }, 
            'Routine'
        );
        schedule.push(...routineBlocks);
        
        if (routineBlocks.length > 0) {
            const lastRoutineBlock = routineBlocks[routineBlocks.length - 1];
            currentTime = addMinutes(lastRoutineBlock.start, lastRoutineBlock.duration);
        }
    }
    
    // FIXED: Fill remaining time with DEEP WORK, not admin
    if (getMinutesBetween(currentTime, morningAdminEnd) >= 30) {
        const morningDeepWorkBlocks = createStandardBlocks(currentTime, morningAdminEnd, 'Deep Work', 'Work');
        schedule.push(...morningDeepWorkBlocks);
    }
    currentTime = morningAdminEnd;
    
    // DEEP WORK PRIME TIME (10 AM - 12 PM) - High energy blocks
    const deepWorkEnd = '12:00';
    const deepWorkTasks = allTasks.filter(t => t.type === 'project' || t.priority === 'High');
    
    if (deepWorkTasks.length > 0) {
        const deepWorkBlocks = createTaskBlocks(
            deepWorkTasks,
            { start: currentTime, end: deepWorkEnd },
            'Deep Work'
        );
        schedule.push(...deepWorkBlocks);
    } else {
        // No tasks - create standard deep work blocks
        const standardDeepWork = createStandardBlocks(currentTime, deepWorkEnd, 'Deep Work', 'Work');
        schedule.push(...standardDeepWork);
    }
    currentTime = deepWorkEnd;
    
    // Lunch break
    schedule.push({
        title: 'Lunch Break',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // AFTERNOON PROJECT WORK (1 PM - 4 PM) - Mix of types
    const afternoonWorkEnd = '16:00';
    const remainingTime = getMinutesBetween(currentTime, afternoonWorkEnd);
    
    if (remainingTime >= 30) {
        // Create variety of afternoon blocks
        let afternoonTime = currentTime;
        
        // 1:00-2:30 - Project/Creative work
        if (getMinutesBetween(afternoonTime, afternoonWorkEnd) >= 90) {
            const creativeBlocks = createStandardBlocks(afternoonTime, addMinutes(afternoonTime, 90), 'Deep Work', 'Work');
            schedule.push(...creativeBlocks);
            afternoonTime = addMinutes(afternoonTime, 90);
        }
        
        // 2:30-4:00 - Mixed work blocks
        if (getMinutesBetween(afternoonTime, afternoonWorkEnd) >= 30) {
            const mixedBlocks = createStandardBlocks(afternoonTime, afternoonWorkEnd, 'Admin', 'Work');
            schedule.push(...mixedBlocks);
        }
    }
    currentTime = afternoonWorkEnd;
    
    // SINGLE afternoon admin block only
    if (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
        schedule.push({
            title: 'End of Day Admin & Wrap-up',
            start: currentTime,
            duration: 30,
            type: 'Admin',
            context: 'Work',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    // Fill remaining work time with meetings/calls
    if (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
        const endWorkBlocks = createStandardBlocks(currentTime, workShift.endTime, 'Meeting', 'Work');
        schedule.push(...endWorkBlocks);
    }
    currentTime = workShift.endTime;
    
    // Evening wrap-up - SINGLE BLOCK
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
    const eveningBlocks = createStandardBlocks(currentTime, '22:00', 'Events', 'Personal');
    schedule.push(...eveningBlocks);
    
    return schedule;
}

function createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity) {
    console.log('Creating home day schedule with task integration');
    
    let schedule = [];
    let currentTime = wakeTime;
    
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
    
    // Routine tasks (must complete by 10 AM)
    const routineEndTime = '10:00';
    if (routineTasks.length > 0 && getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const routineBlocks = createTaskBlocks(
            routineTasks,
            { start: currentTime, end: routineEndTime },
            'Routine'
        );
        schedule.push(...routineBlocks);
        
        if (routineBlocks.length > 0) {
            const lastRoutineBlock = routineBlocks[routineBlocks.length - 1];
            currentTime = addMinutes(lastRoutineBlock.start, lastRoutineBlock.duration);
        }
    }
    
    // Fill to 10 AM if needed
    if (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const morningFillBlocks = createStandardBlocks(currentTime, routineEndTime, 'Admin', 'Personal');
        schedule.push(...morningFillBlocks);
    }
    currentTime = routineEndTime;
    
    // Deep work blocks based on energy
    const deepWorkEnd = '12:00';
    if (energy >= 7 && focusCapacity === 'Sharp') {
        const highPriorityTasks = tasks.filter(t => t.priority === 'High');
        const deepWorkBlocks = createTaskBlocks(
            highPriorityTasks,
            { start: currentTime, end: deepWorkEnd },
            'Deep Work'
        );
        schedule.push(...deepWorkBlocks);
    } else {
        const projectBlocks = createStandardBlocks(currentTime, deepWorkEnd, 'Admin', 'Work');
        schedule.push(...projectBlocks);
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
    
    // Afternoon work
    const afternoonWorkEnd = '15:30';
    const remainingTasks = tasks.filter(t => t.priority !== 'High');
    const afternoonBlocks = createTaskBlocks(
        remainingTasks,
        { start: currentTime, end: afternoonWorkEnd },
        'Admin'
    );
    schedule.push(...afternoonBlocks);
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
    const eveningBlocks = createStandardBlocks(currentTime, '22:00', 'Events', 'Personal');
    schedule.push(...eveningBlocks);
    
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

// Create time blocks in Notion
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`Creating ${schedule.length} time blocks...`);
    
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

// Main workflow with comprehensive error handling
async function runEnhancedScheduler(today) {
    console.log('Starting enhanced scheduler workflow...');
    
    try {
        // Step 1: Clear existing blocks with error handling
        try {
            await clearAutoFilledBlocks(today);
        } catch (clearError) {
            console.error('Failed to clear blocks, continuing:', clearError.message);
        }
        
        // Step 2: Get morning log with fallback
        let morningData;
        try {
            morningData = await getEnhancedMorningLog(today);
        } catch (morningError) {
            console.error('Failed to get morning log, using defaults:', morningError.message);
            morningData = {
                wakeTime: '04:30',
                energy: 7,
                mood: 'Steady',
                focusCapacity: 'Normal',
                socialBattery: 'Full',
                sleepQuality: 7
            };
        }
        
        // Step 3: Check work schedule with fallback
        let workShift;
        try {
            workShift = await getWorkShift(today);
        } catch (workError) {
            console.error('Failed to check work schedule, assuming home day:', workError.message);
            workShift = {
                isWorkDay: false,
                isAtSite: false,
                startTime: '09:00',
                endTime: '17:00',
                title: 'Home Day (Error Fallback)'
            };
        }
        
        // Step 4: Get tasks with comprehensive error handling
        console.log('Fetching tasks from Notion...');
        let allTasks = [];
        let routineTasks = [];
        let projectTasks = [];
        
        try {
            // Validate function exists
            if (typeof getTodaysTasks !== 'function') {
                throw new Error('getTodaysTasks function is not defined - critical error');
            }
            
            console.log('Calling getTodaysTasks function...');
            allTasks = await getTodaysTasks(today);
            
            if (!Array.isArray(allTasks)) {
                console.error('getTodaysTasks returned non-array:', typeof allTasks);
                allTasks = [];
            }
            
            routineTasks = allTasks.filter(t => t && t.routine === true);
            projectTasks = allTasks.filter(t => t && t.routine !== true);
            
            console.log(`Successfully processed ${allTasks.length} tasks (${routineTasks.length} routine, ${projectTasks.length} projects)`);
        } catch (taskError) {
            console.error('Critical failure in task fetching:', taskError.message);
            console.error('Task error stack:', taskError.stack);
            console.log('Continuing with empty task list to prevent total failure');
            
            allTasks = [];
            routineTasks = [];
            projectTasks = [];
        }
        
        // Step 5: Generate schedule with error protection
        let schedule;
        try {
            if (workShift.isWorkDay) {
                console.log('Creating work day schedule...');
                schedule = createWorkDaySchedule(
                    morningData.wakeTime, 
                    workShift, 
                    routineTasks,
                    morningData.energy, 
                    morningData.focusCapacity, 
                    projectTasks
                );
            } else {
                console.log('Creating home day schedule...');
                schedule = createHomeDaySchedule(
                    morningData.wakeTime, 
                    projectTasks,
                    routineTasks,
                    morningData.energy, 
                    morningData.focusCapacity
                );
            }
            
            if (!Array.isArray(schedule)) {
                throw new Error('Schedule creation returned non-array');
            }
            
            console.log(`Generated schedule with ${schedule.length} blocks`);
        } catch (scheduleError) {
            console.error('Failed to create schedule:', scheduleError.message);
            
            // Create minimal fallback schedule
            schedule = [
                {
                    title: 'Morning Routine',
                    start: morningData.wakeTime,
                    duration: 60,
                    type: 'Events',
                    context: 'Personal',
                    energy: 'Medium'
                },
                {
                    title: 'Work Block',
                    start: '09:00',
                    duration: 120,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Medium'
                },
                {
                    title: 'Lunch Break',
                    start: '12:00',
                    duration: 60,
                    type: 'Events',
                    context: 'Personal',
                    energy: 'Low'
                }
            ];
        }
        
        // Step 6: Create blocks in Notion with protection
        let createdBlocks = [];
        try {
            const dailyLogId = await getDailyLogId(today);
            createdBlocks = await createTimeBlocks(schedule, today, dailyLogId);
        } catch (createError) {
            console.error('Failed to create time blocks:', createError.message);
            createdBlocks = [{
                title: 'Error: Could not create blocks',
                error: createError.message,
                status: 'failed'
            }];
        }
        
        // Set results
        global.lastCreationResult = {
            success: createdBlocks.filter(b => b.status === 'created').length,
            failed: createdBlocks.filter(b => b.status === 'failed').length,
            imported: 0,
            exported: 0,
            wakeTime: morningData.wakeTime,
            workDay: workShift.isWorkDay,
            energy: morningData.energy,
            focus: morningData.focusCapacity,
            tasksProcessed: allTasks.length,
            timestamp: new Date().toISOString()
        };
        
        console.log('Enhanced scheduler completed with comprehensive error handling');
        return {
            created: createdBlocks,
            morningData: morningData,
            workShift: workShift,
            tasksFound: allTasks.length
        };
        
    } catch (error) {
        console.error('Critical failure in runEnhancedScheduler:', error.message);
        console.error('Critical error stack:', error.stack);
        
        // Set minimal failure result
        global.lastCreationResult = {
            success: 0,
            failed: 1,
            error: error.message,
            timestamp: new Date().toISOString()
        };
        
        throw error;
    }
}

// Display current schedule
async function getCurrentSchedule(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
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

                if (!startTime) return null;

                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                const utcStart = new Date(startTime);
                const pacificStart = new Date(utcStart.getTime() - (7 * 60 * 60 * 1000));
                const pacificDateStr = pacificStart.toISOString().split('T')[0];
                
                if (pacificDateStr !== today) return null;

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: getTypeClass(type),
                    energy: 'medium',
                    details: `${context} • ${type}${autoFilled ? ' • AI Enhanced' : ''}`
                };
            } catch (error) {
                console.error('Error processing schedule block:', error.message);
                return null;
            }
        }).filter(block => block !== null);

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

// Vercel handler with function validation
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('Clean Scheduler v3.0 - Syntax Fixed');
        
        // Critical function validation
        console.log('Function validation:');
        console.log('- getTodaysTasks:', typeof getTodaysTasks);
        console.log('- getWorkShift:', typeof getWorkShift);
        console.log('- createWorkDaySchedule:', typeof createWorkDaySchedule);
        console.log('- createHomeDaySchedule:', typeof createHomeDaySchedule);
        console.log('- runEnhancedScheduler:', typeof runEnhancedScheduler);
        
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
            console.log('Running clean scheduler...');
            
            if (typeof getTodaysTasks !== 'function') {
                console.error('CRITICAL: getTodaysTasks is not a function');
                console.error('Type:', typeof getTodaysTasks);
                throw new Error('getTodaysTasks function is not available');
            }
            
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
                lastCreationResult: global.lastCreationResult || null,
                processingTimeMs: processingTime,
                timestamp: now.toISOString(),
                version: '3.0-Clean-Syntax',
                calendarEnabled: calendarEnabled,
                functionCheck: {
                    getTodaysTasks: typeof getTodaysTasks,
                    getWorkShift: typeof getWorkShift,
                    createWorkDaySchedule: typeof createWorkDaySchedule
                }
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

        console.log(`Request completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('Clean Scheduler Error:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({ 
            error: 'Clean scheduler failed',
            details: error.message,
            stack: error.stack,
            meta: {
                version: '3.0-Clean-Syntax',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled,
                functionCheck: {
                    getTodaysTasks: typeof getTodaysTasks,
                    getWorkShift: typeof getWorkShift
                }
            }
        });
    }
};
