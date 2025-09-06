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

// Get tasks with proper sorting
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

        const tasks = tasksResponse.results.map(task => {
            const props = task.properties;
            const title = props.Name?.title?.[0]?.text?.content || 'Untitled Task';
            const priority = props['Priority Level']?.select?.name || 'Medium';
            const type = props.Type?.select?.name || 'Admin';
            const estimatedTime = props['Estimated Duration']?.number || 30;
            const dueDate = props['Due Date']?.date?.start || null;
            
            const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
            
            let priorityScore = 3;
            if (priority === 'High' || priority === 'Urgent') priorityScore = 1;
            else if (priority === 'Low') priorityScore = 5;
            else if (priority === 'Routine') priorityScore = 4;
            
            return {
                title,
                priority,
                priorityScore,
                type: type.toLowerCase(),
                routine,
                estimatedTime: Math.max(30, estimatedTime),
                dueDate,
                id: task.id,
                used: false
            };
        });

        tasks.sort((a, b) => {
            if (a.priorityScore !== b.priorityScore) {
                return a.priorityScore - b.priorityScore;
            }
            
            if (a.dueDate && b.dueDate) {
                return new Date(a.dueDate) - new Date(b.dueDate);
            }
            if (a.dueDate && !b.dueDate) return -1;
            if (!a.dueDate && b.dueDate) return 1;
            
            return 0;
        });

        console.log(`Sorted ${tasks.length} tasks by priority and due date`);
        return tasks;
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        return [];
    }
}

// Task assignment function
function assignTaskToBlock(availableTasks, blockType) {
    if (!availableTasks || availableTasks.length === 0) return null;
    
    const unscheduledTasks = availableTasks.filter(task => {
        if (!task || typeof task !== 'object') return false;
        if (task.used === true) return false;
        if (!task.title || typeof task.title !== 'string') return false;
        
        if (typeof task.priorityScore !== 'number') {
            const priority = task.priority || 'Medium';
            task.priorityScore = priority === 'High' || priority === 'Urgent' ? 1 : 
                               priority === 'Low' ? 5 : 
                               priority === 'Routine' ? 4 : 3;
        }
        
        return true;
    });
    
    if (unscheduledTasks.length === 0) return null;
    
    if (blockType === 'Deep Work') {
        const highPriorityTask = unscheduledTasks.find(task => task.priorityScore <= 2);
        if (highPriorityTask) {
            highPriorityTask.used = true;
            return highPriorityTask;
        }
    }
    
    if (blockType === 'Routine') {
        const routineTask = unscheduledTasks.find(task => task.routine === true);
        if (routineTask) {
            routineTask.used = true;
            return routineTask;
        }
    }
    
    const suitableTask = unscheduledTasks[0];
    
    if (suitableTask) {
        suitableTask.used = true;
        return suitableTask;
    }
    
    return null;
}

// Break logic
function shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, nextBlockType) {
    const currentHour = parseInt(currentTime.split(':')[0]);
    const currentMinute = parseInt(currentTime.split(':')[1]);
    const totalMinutes = currentHour * 60 + currentMinute;
    
    if (currentHour <= 6) return false;
    if (currentHour === 11 && currentMinute >= 30) return false;
    if (currentHour === 13 && currentMinute <= 30) return false;
    
    if (lastBreakTime) {
        const [lastHour, lastMin] = lastBreakTime.split(':').map(Number);
        const lastBreakMinutes = lastHour * 60 + lastMin;
        if (totalMinutes - lastBreakMinutes < 45) return false;
    }
    
    if (consecutiveWorkMinutes >= 90) return true;
    if (consecutiveWorkMinutes >= 60 && nextBlockType === 'Deep Work') return true;
    
    return false;
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

// Get morning log
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

// Work day schedule
function createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity, projectTasks) {
    console.log(`Creating work day schedule: Energy=${energy}, Focus=${focusCapacity}`);
    
    const schedule = [];
    let currentTime = wakeTime;
    let consecutiveWorkMinutes = 0;
    let lastBreakTime = null;
    
    const allTasks = [...routineTasks, ...projectTasks];
    const maxConsecutiveWork = focusCapacity === 'Sharp' ? 120 : focusCapacity === 'Normal' ? 90 : 60;
    const deepWorkCapacity = energy >= 7 && focusCapacity !== 'Scattered';
    
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
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 30);
    consecutiveWorkMinutes = 30;
    
    // Morning routine tasks
    const morningAdminEnd = '10:00';
    while (getMinutesBetween(currentTime, morningAdminEnd) >= 30) {
        const routineTask = assignTaskToBlock(routineTasks, 'Routine');
        
        if (routineTask) {
            schedule.push({
                title: routineTask.title,
                start: currentTime,
                duration: 30,
                type: 'Routine',
                context: 'Work',
                energy: 'Medium'
            });
        } else {
            schedule.push({
                title: 'Morning Admin Tasks',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Medium'
            });
        }
        
        
        currentTime = addMinutes(currentTime, 30);
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Deep Work') && 
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
    lastBreakTime = currentTime;
    
    // Afternoon work
    const afternoonWorkEnd = '15:30';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const remainingTask = assignTaskToBlock(allTasks, 'Admin');
        
        if (remainingTask) {
            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Medium'
            });
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
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Admin') && 
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

// Main scheduler workflow
async function runEnhancedScheduler(today) {
    console.log('Starting enhanced scheduler workflow...');
    
    try {
        try {
            await clearAutoFilledBlocks(today);
        } catch (clearError) {
            console.error('Failed to clear blocks, continuing:', clearError.message);
        }
        
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
        
        console.log('Fetching tasks from Notion...');
        let allTasks = [];
        let routineTasks = [];
        let projectTasks = [];
        
        try {
            if (typeof getTodaysTasks !== 'function') {
                throw new Error('getTodaysTasks function is not defined - critical error');
            }
            
            console.log('Calling getTodaysTasks function...');
            allTasks = await getTodaysTasks(today);
            
            if (!Array.isArray(allTasks)) {
                console.error('getTodaysTasks returned non-array:', typeof allTasks);
                allTasks = [];
            }
            
            allTasks = allTasks.map(task => {
                if (!task.priorityScore) {
                    const priority = task.priority || 'Medium';
                    task.priorityScore = priority === 'High' || priority === 'Urgent' ? 1 : 
                                       priority === 'Low' ? 5 : 
                                       priority === 'Routine' ? 4 : 3;
                }
                if (task.used === undefined) {
                    task.used = false;
                }
                return task;
            });
            
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
        
        console.log(`Getting schedule for ${today} Pacific`);
        console.log(`UTC range: ${dayRange.start} to ${dayRange.end}`);
        
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
                    console.log(`Filtering out block "${title}" - Pacific date: ${pacificDateString}, target: ${today}`);
                    return null;
                }

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
        console.log('Clean Scheduler v4.0 - Complete Rewrite');
        
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
                version: '4.0-Complete-Rewrite',
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
                version: '4.0-Complete-Rewrite',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};
        consecutiveWorkMinutes += 30;
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Admin') && 
            getMinutesBetween(currentTime, morningAdminEnd) >= 45) {
            
            schedule.push({
                title: 'Energy Break',
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
    currentTime = morningAdminEnd;
    consecutiveWorkMinutes = 0;
    
    // Peak deep work time
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        const highPriorityTasks = allTasks.filter(t => t && typeof t.priorityScore === 'number' && t.priorityScore <= 2);
        const highPriorityTask = assignTaskToBlock(highPriorityTasks, 'Deep Work');
        
        if (highPriorityTask && deepWorkCapacity) {
            schedule.push({
                title: highPriorityTask.title,
                start: currentTime,
                duration: 30,
                type: 'Deep Work',
                context: 'Work',
                energy: 'High',
                taskId: highPriorityTask.taskId || null
            });
            consecutiveWorkMinutes += 30;
        } else if (deepWorkCapacity) {
            const anyTask = assignTaskToBlock(allTasks, 'Deep Work');
            if (anyTask) {
                schedule.push({
                    title: anyTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: anyTask.taskId || null
                });
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
            const mediumTask = assignTaskToBlock(allTasks, 'Admin');
            if (mediumTask) {
                schedule.push({
                    title: mediumTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Medium',
                    taskId: mediumTask.taskId || null
                });
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
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Deep Work') && 
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
        }
    }
    currentTime = deepWorkEnd;
    
    // Lunch break
    const lunchDuration = energy <= 5 ? 75 : 60;
    schedule.push({
        title: energy <= 5 ? 'Extended Lunch & Recovery' : 'Lunch Break',
        start: currentTime,
        duration: lunchDuration,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, lunchDuration);
    consecutiveWorkMinutes = 0;
    lastBreakTime = currentTime;
    
    // Afternoon work
    const afternoonWorkEnd = '16:00';
    while (getMinutesBetween(currentTime, afternoonWorkEnd) >= 30) {
        const availableTask = assignTaskToBlock(allTasks, 'Admin');
        
        if (availableTask) {
            const blockType = availableTask.priorityScore <= 2 && energy >= 6 ? 'Deep Work' : 'Admin';
            schedule.push({
                title: availableTask.title,
                start: currentTime,
                duration: 30,
                type: blockType,
                context: 'Work',
                energy: blockType === 'Deep Work' ? 'High' : 'Medium'
            });
        } else {
            const currentHour = parseInt(currentTime.split(':')[0]);
            let blockTitle = 'Administrative Work';
            let blockType = 'Admin';
            
            if (currentHour === 13 && energy >= 6) {
                blockTitle = 'Afternoon Project Focus';
            } else if (currentHour >= 14) {
                blockTitle = 'Communications & Meetings';
                blockType = 'Meeting';
            }
            
            schedule.push({
                title: blockTitle,
                start: currentTime,
                duration: 30,
                type: blockType,
                context: 'Work',
                energy: 'Medium'
            });
        }
        
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes += 30;
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Admin') && 
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
    
    // End of day work
    while (getMinutesBetween(currentTime, workShift.endTime) >= 30) {
        const lightTasks = allTasks.filter(t => t && typeof t.priorityScore === 'number' && t.priorityScore >= 4);
        const lightTask = assignTaskToBlock(lightTasks, 'Admin');
        
        if (lightTask) {
            schedule.push({
                title: lightTask.title,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Low'
            });
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
    console.log(`Created work schedule with ${schedule.length} blocks, scheduled ${tasksScheduled}/${allTasks.length} tasks`);
    
    return schedule;
}

// Home day schedule
function createHomeDaySchedule(wakeTime, projectTasks, routineTasks, energy, focusCapacity) {
    console.log('Creating home day schedule');
    
    const schedule = [];
    let currentTime = wakeTime;
    let consecutiveWorkMinutes = 0;
    let lastBreakTime = null;
    
    const allTasks = [...routineTasks, ...projectTasks];
    
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
    
    // Routine tasks
    const routineEndTime = '10:00';
    while (getMinutesBetween(currentTime, routineEndTime) >= 30) {
        const routineTask = assignTaskToBlock(routineTasks, 'Routine');
        
        if (routineTask) {
            schedule.push({
                title: routineTask.title,
                start: currentTime,
                duration: 30,
                type: 'Routine',
                context: 'Work',
                energy: 'Medium'
            });
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
        
        if (shouldInsertBreak(currentTime, lastBreakTime, consecutiveWorkMinutes, 'Admin') && 
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
    
    // Deep work blocks
    const deepWorkEnd = '12:00';
    while (getMinutesBetween(currentTime, deepWorkEnd) >= 30) {
        if (energy >= 7 && focusCapacity === 'Sharp') {
            const highPriorityTasks = allTasks.filter(t => t && typeof t.priorityScore === 'number' && t.priorityScore <= 2);
            const highPriorityTask = assignTaskToBlock(highPriorityTasks, 'Deep Work');
            if (highPriorityTask) {
                schedule.push({
                    title: highPriorityTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High'
                });
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
            const anyTask = assignTaskToBlock(allTasks, 'Admin');
            if (anyTask) {
                schedule.push({
                    title: anyTask.title,
                    start: currentTime,
                    duration: 30,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Medium'
                });
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
