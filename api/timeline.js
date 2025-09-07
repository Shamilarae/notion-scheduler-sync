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
            }
        
        // Add afternoon breaks
        if (shouldAddBreak(slot.start, 90)) {
            schedule.push({
                title: 'Afternoon Energy Break',
                start: addMinutes(slot.start, slot.duration),
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
        }
    });
    
    // PHASE 5: End of day
    addEndOfDayBlocks(schedule, workShift);
    
    // Calculate metrics
    const totalTaskTime = flexibleTasks.reduce((sum, task) => sum + task.estimatedTime, 0);
    const schedulingEfficiency = Math.round((scheduledTaskMinutes / totalTaskTime) * 100);
    const completedTasks = [...taskQueue.highPriority, ...taskQueue.medium, ...taskQueue.routine]
        .filter(task => task.remainingTime <= 0).length;
    
    console.log(`Intelligent scheduling complete:`);
    console.log(`   Total blocks: ${schedule.length}`);
    console.log(`   Scheduled task time: ${scheduledTaskMinutes}/${totalTaskTime}min (${schedulingEfficiency}%)`);
    console.log(`   Tasks completed: ${completedTasks}/${flexibleTasks.length}`);
    console.log(`   Tasks deferred: ${taskQueue.deferred.length}`);
    
    return schedule;
}

function addEndOfDayBlocks(schedule, workShift) {
    const endTime = workShift.isAtSite ? '17:30' : '17:00';
    
    // Add end of work day blocks
    if (workShift.isAtSite) {
        schedule.push({
            title: 'End of Day Wrap-up',
            start: '16:00',
            duration: 90,
            type: 'Admin',
            context: 'Work',
            energy: 'Low'
        });
    }
    
    schedule.push({
        title: 'Day Review & Tomorrow Planning',
        start: endTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Low'
    });
    
    let personalTime = addMinutes(endTime, 30);
    
    if (!workShift.isAtSite) {
        // Home day: Add family time
        schedule.push({
            title: 'Riley Time (After School)',
            start: personalTime,
            duration: 120,
            type: 'Events',
            context: 'Family',
            energy: 'Med'
        });
        personalTime = addMinutes(personalTime, 120);
        
        schedule.push({
            title: 'Dinner & Family Time',
            start: personalTime,
            duration: 90,
            type: 'Events',
            context: 'Family',
            energy: 'Low'
        });
        personalTime = addMinutes(personalTime, 90);
    }
    
    schedule.push({
        title: 'Personal Wind Down',
        start: personalTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    personalTime = addMinutes(personalTime, 60);
    
    // Fill remaining evening with personal time
    while (getMinutesBetween(personalTime, '22:00') >= 30) {
        schedule.push({
            title: 'Personal Time',
            start: personalTime,
            duration: 30,
            type: 'Events',
            context: 'Personal',
            energy: 'Low'
        });
        personalTime = addMinutes(personalTime, 30);
    }
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

// Create time blocks with proper task relations and Fixed Time handling
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`Creating ${schedule.length} time blocks with enhanced task relations...`);
    
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
            
            // Link tasks with proper validation
            if (block.taskId && typeof block.taskId === 'string') {
                properties['Tasks'] = { relation: [{ id: block.taskId }] };
                const fixedTimeIndicator = block.isFixedTime ? ' [FIXED TIME]' : '';
                console.log(`Linking task ${block.taskId} to time block "${block.title}"${fixedTimeIndicator}`);
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
            
            if (block.progress) {
                properties['Notes'] = {
                    rich_text: [{ text: { content: `Task progress: ${block.progress}` } }]
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

// MAIN ENHANCED WORKFLOW
async function runEnhancedScheduler(today) {
    console.log('Starting ENHANCED scheduler with Fixed Time & Priority Intelligence...');
    
    if (!today || typeof today !== 'string') {
        throw new Error('Invalid today parameter - must be a valid date string');
    }
    
    let lastCreationResult = null;
    
    try {
        await clearAutoFilledBlocks(today);
        
        console.log('Gathering comprehensive data...');
        const morningData = await getEnhancedMorningLog(today);
        const workShift = await getWorkShift(today);
        const tasks = await getTodaysTasks(today);
        
        if (!tasks || (!tasks.flexibleTasks && !tasks.fixedTimeTasks)) {
            throw new Error('Failed to get task data');
        }
        
        console.log('Generating INTELLIGENT schedule with Fixed Time placement...');
        const schedule = createIntelligentSchedule(
            morningData.wakeTime, 
            workShift, 
            tasks,
            morningData
        );
        
        if (!Array.isArray(schedule) || schedule.length === 0) {
            throw new Error('Schedule generation failed - no blocks created');
        }
        
        console.log('Creating time blocks in Notion...');
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
        
        console.log(`ENHANCED scheduler completed:`);
        console.log(`   ${successfulBlocks} blocks created, ${failedBlocks} failed`);
        console.log(`   ${fixedTimeBlocks} fixed-time tasks placed`);
        console.log(`   ${tasksScheduled - fixedTimeBlocks} flexible tasks scheduled`);
        
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
        console.error('Critical failure in ENHANCED scheduler:', error.message);
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
                    details: `${context} • ${type}${hasTask ? ' • Task Linked' : ''}${autoFilled ? ' • AI Enhanced' : ''}`
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
        console.log('INTELLIGENT Scheduler v6.0 - Capacity Planning + Routine Morning Priority');
        
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
            console.log('Running INTELLIGENT scheduler with capacity planning...');
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
                version: '6.0-Intelligent-Capacity-Planning',
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

        console.log(`INTELLIGENT request completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('INTELLIGENT Scheduler Error:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({ 
            error: 'INTELLIGENT scheduler failed',
            details: error.message,
            stack: error.stack,
            meta: {
                version: '6.0-Intelligent-Capacity-Planning',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};,
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

// CORRECTED: Get today's tasks with simplified filtering
async function getTodaysTasks(today) {
    try {
        if (!today || typeof today !== 'string') {
            console.error('Invalid today parameter:', today);
            return { flexibleTasks: [], fixedTimeTasks: [] };
        }
        
        console.log('Querying tasks database with corrected filtering...');
        
        // Get ALL active tasks - don't filter by date at query level
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Status',
                        select: { does_not_equal: 'Done' }
                    },
                    {
                        property: 'Done',
                        checkbox: { equals: false }
                    }
                ]
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 100
        });

        console.log(`Found ${tasksResponse.results.length} total tasks in database`);

        const flexibleTasks = [];
        const fixedTimeTasks = [];

        tasksResponse.results.forEach(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn('Skipping task with empty title:', task.id);
                    return;
                }
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || 'Admin';
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                const fixedTime = props['Fixed Time']?.date?.start;
                const scheduleToday = props['Schedule Today?']?.checkbox || false;
                
                // Only include tasks that should be scheduled today
                const shouldScheduleToday = scheduleToday || 
                    fixedTime || 
                    (dueDate && new Date(dueDate) <= new Date(today + 'T23:59:59'));
                
                if (!shouldScheduleToday) {
                    return; // Skip tasks not meant for today
                }
                
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
                        const todayDateTime = new Date(today + 'T00:00:00');
                        const dueDays = Math.ceil((dueDateTime - todayDateTime) / (1000 * 60 * 60 * 24));
                        
                        if (dueDays <= 0) priorityScore = Math.max(1, priorityScore - 2); // Overdue
                        else if (dueDays <= 1) priorityScore = Math.max(1, priorityScore - 1); // Due today/tomorrow
                    } catch (dateError) {
                        console.warn(`Error parsing due date for task ${title}:`, dateError.message);
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
                    console.log(`FIXED TIME TASK: "${title}" at ${fixedTimePacific}`);
                } else {
                    flexibleTasks.push(taskData);
                    console.log(`FLEXIBLE TASK: "${title}" (${priority})`);
                }
                
            } catch (taskError) {
                console.error('Error processing individual task:', taskError.message);
            }
        });
        
        console.log(`Task categorization complete:`);
        console.log(`   Fixed Time Tasks: ${fixedTimeTasks.length}`);
        console.log(`   Flexible Tasks: ${flexibleTasks.length}`);
        
        return { flexibleTasks, fixedTimeTasks };
        
    } catch (error) {
        console.error('Error getting tasks:', error.message);
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
        sleepQuality: 7,
        sleepHours: 7,
        bodyStatus: 'Normal',
        stressLevel: 'Normal',
        weatherImpact: 'None'
    };
    
    try {
        console.log('Getting today\'s morning log for intelligent scheduling...');
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
        
        console.log('Parsed comprehensive morning log:', {
            energy: data.energy,
            mood: data.mood,
            focus: data.focusCapacity,
            sleepQuality: data.sleepQuality
        });
        
        return data;
        
    } catch (error) {
        console.error('Error fetching morning log:', error.message);
        return defaultData;
    }
}

// Calculate urgency score for tasks
function calculateUrgencyScore(task, today) {
    let urgencyScore = 5; // Default medium urgency
    
    if (task.dueDate) {
        const dueDate = new Date(task.dueDate);
        const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
        
        if (daysUntilDue <= 0) urgencyScore = 10; // Overdue
        else if (daysUntilDue <= 1) urgencyScore = 9; // Due today/tomorrow
        else if (daysUntilDue <= 3) urgencyScore = 7; // Due soon
        else if (daysUntilDue <= 7) urgencyScore = 5; // Due this week
        else urgencyScore = 3; // Future
    }
    
    if (task.scheduleToday) urgencyScore = Math.max(urgencyScore, 8);
    if (task.fixedTime) urgencyScore = 10;
    
    return urgencyScore;
}

// Intelligent task prioritization and capacity planning
function prioritizeAndSizeTasks(tasks, availableMinutes) {
    console.log(`Analyzing ${tasks.length} tasks for ${availableMinutes}min capacity...`);
    
    const today = new Date();
    
    const categorizedTasks = {
        highPriority: [],
        medium: [],
        routine: [],
        deferred: []
    };
    
    // Calculate urgency and capacity requirements
    tasks.forEach(task => {
        const taskWithMetrics = {
            ...task,
            remainingTime: task.estimatedTime,
            urgencyScore: calculateUrgencyScore(task, today),
            canFitToday: task.estimatedTime <= availableMinutes * 0.7 // Leave 30% buffer
        };
        
        // Intelligent categorization based on priority, urgency, and capacity
        if (task.priority === 'Routine') {
            categorizedTasks.routine.push(taskWithMetrics);
        } else if (task.priorityScore <= 2 && taskWithMetrics.urgencyScore >= 8) {
            categorizedTasks.highPriority.push(taskWithMetrics);
        } else if (taskWithMetrics.canFitToday && taskWithMetrics.urgencyScore >= 5) {
            categorizedTasks.medium.push(taskWithMetrics);
        } else {
            categorizedTasks.deferred.push(taskWithMetrics);
            console.log(`Deferred: ${task.title} (${task.estimatedTime}min, urgency: ${taskWithMetrics.urgencyScore})`);
        }
    });
    
    // Sort each category by priority score and urgency
    Object.keys(categorizedTasks).forEach(category => {
        categorizedTasks[category].sort((a, b) => {
            if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
            return b.urgencyScore - a.urgencyScore;
        });
    });
    
    console.log(`High Priority: ${categorizedTasks.highPriority.length}`);
    console.log(`Medium: ${categorizedTasks.medium.length}`);
    console.log(`Routine: ${categorizedTasks.routine.length}`);
    console.log(`Deferred: ${categorizedTasks.deferred.length}`);
    
    return categorizedTasks;
}

function getNextPriorityTask(taskArray, availableMinutes) {
    return taskArray.find(task => task.remainingTime > 0 && task.remainingTime <= availableMinutes * 1.2);
}

function generateTimeSlots(startTime, endTime, slotDuration) {
    const slots = [];
    let current = startTime;
    
    while (getMinutesBetween(current, endTime) >= slotDuration) {
        slots.push({
            start: current,
            duration: slotDuration
        });
        current = addMinutes(current, slotDuration);
    }
    
    return slots;
}

function findFixedTimeConflict(fixedTimeTasks, slotTime) {
    return fixedTimeTasks.find(ft => {
        const fixedMinutes = timeStringToMinutes(ft.scheduledTime);
        const slotMinutes = timeStringToMinutes(slotTime);
        return Math.abs(fixedMinutes - slotMinutes) <= 15; // 15-minute tolerance
    });
}

function shouldAddBreak(currentTime, frequency) {
    // Add breaks at strategic times, not after every block
    const breakTimes = ['06:15', '07:30', '09:00', '11:15', '14:15', '15:45'];
    return breakTimes.includes(currentTime);
}

// INTELLIGENT: Capacity-based task scheduling with routine morning priority
function createIntelligentSchedule(wakeTime, workShift, tasks, morningData) {
    const { flexibleTasks, fixedTimeTasks } = tasks;
    
    console.log(`Creating INTELLIGENT capacity-aware schedule...`);
    
    let schedule = [];
    
    // Calculate total available work capacity for the day
    const workDayMinutes = workShift.isAtSite ? 720 : 480; // 12 hours site, 8 hours home
    const breakMinutes = 135; // Breaks + lunch
    const routineMinutes = 120; // Morning/evening routines
    const availableWorkMinutes = workDayMinutes - breakMinutes - routineMinutes;
    
    console.log(`Capacity Analysis: ${availableWorkMinutes}min available work time`);
    
    // Intelligent task prioritization and capacity planning
    const taskQueue = prioritizeAndSizeTasks(flexibleTasks, availableWorkMinutes);
    
    // Energy and focus parameters
    const energyLevel = Math.max(1, Math.min(10, morningData.energy || 7));
    const canDeepFocus = morningData.focusCapacity === 'Sharp' && energyLevel >= 7;
    const needsFrequentBreaks = morningData.stressLevel === 'Maxed Out' || 
                                morningData.bodyStatus === 'Tired' || 
                                morningData.sleepHours < 6;
    
    console.log(`Energy Profile: Deep Focus ${canDeepFocus ? 'Available' : 'Limited'}`);
    
    let scheduledTaskMinutes = 0;
    let currentTime = wakeTime;
    
    // PHASE 1: Morning Setup
    schedule.push({
        title: workShift.isAtSite ? 'Morning Routine (Work Camp)' : 'Morning Routine & Coffee',
        start: currentTime,
        duration: workShift.isAtSite ? 30 : 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, workShift.isAtSite ? 30 : 60);
    
    schedule.push({
        title: 'Morning Planning & Priority Review',
        start: currentTime,
        duration: 30,
        type: 'Admin',
        context: workShift.isAtSite ? 'Work' : 'Personal',
        energy: 'Med'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // PHASE 2: ROUTINE TASKS COMPLETION (05:30-10:00 AM)
    console.log('ROUTINE PHASE: Completing all routine tasks before 10 AM');
    const routineEndTime = '10:00';
    const routineSlots = generateTimeSlots(currentTime, routineEndTime, 30);
    
    routineSlots.forEach(slot => {
        // Check for fixed-time conflicts first
        const fixedTask = findFixedTimeConflict(fixedTimeTasks, slot.start);
        
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
            console.log(`FIXED TIME: ${fixedTask.scheduledTime} - ${fixedTask.title}`);
        } else {
            // Prioritize routine tasks in morning
            const routineTask = getNextPriorityTask(taskQueue.routine, slot.duration);
            if (routineTask) {
                const taskDuration = Math.min(slot.duration, routineTask.remainingTime);
                schedule.push({
                    title: routineTask.title,
                    start: slot.start,
                    duration: taskDuration,
                    type: 'Routine',
                    context: 'Work',
                    energy: 'Med',
                    taskId: routineTask.id,
                    progress: taskDuration < routineTask.estimatedTime ? `${taskDuration}/${routineTask.estimatedTime}min` : null
                });
                routineTask.remainingTime -= taskDuration;
                scheduledTaskMinutes += taskDuration;
                console.log(`${slot.start}: ${routineTask.title} (${taskDuration}min, ${routineTask.remainingTime}min remaining)`);
            } else {
                schedule.push({
                    title: 'Morning Admin & Setup',
                    start: slot.start,
                    duration: slot.duration,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
        }
        
        // Add break if needed
        if (shouldAddBreak(slot.start, 90)) {
            schedule.push({
                title: 'Energy Break',
                start: addMinutes(slot.start, slot.duration),
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
        }
    });
    
    // PHASE 3: DEEP WORK PHASE (10:00 AM - 12:00 PM)
    console.log('DEEP WORK PHASE: High priority tasks in peak focus time');
    const deepWorkSlots = generateTimeSlots('10:00', '12:00', 30);
    
    deepWorkSlots.forEach(slot => {
        const fixedTask = findFixedTimeConflict(fixedTimeTasks, slot.start);
        
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
            console.log(`FIXED TIME: ${fixedTask.scheduledTime} - ${fixedTask.title}`);
        } else if (canDeepFocus) {
            const highPriorityTask = getNextPriorityTask(taskQueue.highPriority, 60);
            if (highPriorityTask) {
                const taskDuration = Math.min(60, highPriorityTask.remainingTime);
                schedule.push({
                    title: highPriorityTask.title,
                    start: slot.start,
                    duration: taskDuration,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High',
                    taskId: highPriorityTask.id,
                    progress: taskDuration < highPriorityTask.estimatedTime ? `${taskDuration}/${highPriorityTask.estimatedTime}min` : null
                });
                highPriorityTask.remainingTime -= taskDuration;
                scheduledTaskMinutes += taskDuration;
                console.log(`${slot.start}: ${highPriorityTask.title} (${taskDuration}min deep work)`);
            } else {
                schedule.push({
                    title: 'Deep Focus Session',
                    start: slot.start,
                    duration: 60,
                    type: 'Deep Work',
                    context: 'Work',
                    energy: 'High'
                });
            }
        } else {
            schedule.push({
                title: 'Project Work',
                start: slot.start,
                duration: 30,
                type: 'Admin',
                context: 'Work',
                energy: 'Med'
            });
        }
    });
    
    // Add lunch break
    schedule.push({
        title: (energyLevel <= 5 || morningData.stressLevel === 'Maxed Out') ? 'Extended Lunch & Recovery' : 'Lunch Break',
        start: '12:00',
        duration: (energyLevel <= 5 || morningData.stressLevel === 'Maxed Out') ? 75 : 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    
    // PHASE 4: AFTERNOON ADMIN PHASE (13:00 - 16:00)
    console.log('AFTERNOON PHASE: Medium priority and admin tasks');
    const afternoonSlots = generateTimeSlots('13:00', workShift.isAtSite ? '16:00' : '15:30', 30);
    
    afternoonSlots.forEach(slot => {
        const fixedTask = findFixedTimeConflict(fixedTimeTasks, slot.start);
        
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
        } else {
            // Try medium priority tasks, then high priority overflow
            const mediumTask = getNextPriorityTask([...taskQueue.medium, ...taskQueue.highPriority.filter(t => t.remainingTime > 0)], slot.duration);
            if (mediumTask) {
                const taskDuration = Math.min(slot.duration, mediumTask.remainingTime);
                schedule.push({
                    title: mediumTask.title,
                    start: slot.start,
                    duration: taskDuration,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med',
                    taskId: mediumTask.id,
                    progress: taskDuration < mediumTask.estimatedTime ? `${taskDuration}/${mediumTask.estimatedTime}min` : null
                });
                mediumTask.remainingTime -= taskDuration;
                scheduledTaskMinutes += taskDuration;
                console.log(`${slot.start}: ${mediumTask.title} (${taskDuration}min admin work)`);
            } else {
                schedule.push({
                    title: 'Afternoon Project Work',
                    start: slot.start,
                    duration: slot.duration,
                    type: 'Admin',
                    context: 'Work',
                    energy: 'Med'
                });
            }
