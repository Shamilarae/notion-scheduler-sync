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

// Calendar routing configuration
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

// Initialize Google Calendar
try {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        const { google } = require('googleapis');
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });

        calendar = google.calendar({ version: 'v3', auth });
        calendarEnabled = true;
        console.log('Google Calendar integration enabled with 9 specialized calendars');
    } else {
        console.log('Google Calendar disabled: Missing credentials');
    }
} catch (error) {
    console.error('Google Calendar initialization failed:', error.message);
    console.log('Continuing with Notion-only scheduling');
}

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

// STEP 1: CALENDAR SYNC IN (Existing Events → Time Blocks) - WITH DEDUPLICATION
async function syncCalendarEventsToTimeBlocks(today) {
    const results = {
        imported: 0,
        updated: 0,
        errors: [],
        details: [],
        duplicatesSkipped: 0
    };

    if (!calendarEnabled) {
        console.log('Calendar sync disabled - skipping import');
        return results;
    }

    try {
        console.log('STEP 1: Syncing calendar events to Time Blocks...');
        const dayRange = getPacificDateRange(today);
        
        console.log(`Strict filtering for events on ${today} only`);
        console.log(`Date range: ${dayRange.start} to ${dayRange.end}`);
        
        // Track processed events to avoid duplicates
        const processedEvents = new Set();
        
        // Import from all specialized calendars
        for (const [contextType, calendarId] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
            try {
                const [context, type] = contextType.split('-');
                console.log(`Importing from ${contextType} calendar...`);
                
                const eventsResponse = await calendar.events.list({
                    calendarId: calendarId,
                    timeMin: dayRange.start,
                    timeMax: dayRange.end,
                    singleEvents: true,
                    maxResults: 50,
                    showDeleted: false,
                    timeZone: 'America/Vancouver'
                });

                const events = eventsResponse.data.items || [];
                console.log(`Found ${events.length} events in ${contextType}`);

                for (const event of events) {
                    try {
                        if (!event.start?.dateTime || !event.end?.dateTime) {
                            console.warn(`Skipping all-day event: ${event.summary}`);
                            continue;
                        }

                        // STRICT DATE FILTERING - only events that actually occur today
                        const eventStartUTC = new Date(event.start.dateTime);
                        const eventPacificDate = new Intl.DateTimeFormat('en-CA', {
                            timeZone: 'America/Vancouver',
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit'
                        }).format(eventStartUTC);

                        if (eventPacificDate !== today) {
                            console.log(`Skipping event from different date: "${event.summary}" (${eventPacificDate} != ${today})`);
                            continue;
                        }

                        const title = event.summary || 'Untitled Event';
                        const startTime = utcToPacificTime(event.start.dateTime);
                        const endTime = utcToPacificTime(event.end.dateTime);
                        
                        // Validate time format - skip if conversion failed
                        if (!startTime.match(/^\d{2}:\d{2}$/) || !endTime.match(/^\d{2}:\d{2}$/)) {
                            console.warn(`Skipping event with invalid time format: ${title} (${startTime}-${endTime})`);
                            continue;
                        }
                        
                        // Create unique key for deduplication based on title and time
                        const eventKey = `${title}|${startTime}|${endTime}`;
                        
                        if (processedEvents.has(eventKey)) {
                            console.log(`Skipping duplicate event: ${title} at ${startTime} (already processed)`);
                            results.duplicatesSkipped++;
                            continue;
                        }
                        
                        processedEvents.add(eventKey);
                        const gCalId = event.id;

                        // Check if Time Block already exists by GCal ID
                        const existingBlocks = await notion.databases.query({
                            database_id: TIME_BLOCKS_DB_ID,
                            filter: {
                                property: 'GCal ID',
                                rich_text: { equals: gCalId }
                            },
                            page_size: 1
                        });

                        const energyReq = inferEnergyFromType(type);
                        
                        const timeBlockData = {
                            Title: { title: [{ text: { content: title } }] },
                            Type: { select: { name: type } },
                            Context: { select: { name: context } },
                            'Start Time': { date: { start: event.start.dateTime } },
                            'End Time': { date: { start: event.end.dateTime } },
                            'Energy Requirements': { select: { name: energyReq } },
                            Status: { select: { name: 'Planned' } },
                            'GCal ID': { rich_text: [{ text: { content: gCalId } }] },
                            'Auto-Filled': { checkbox: false },
                            Notes: { 
                                rich_text: [{ 
                                    text: { 
                                        content: `Imported from ${contextType} calendar\n${event.description || ''}` 
                                    } 
                                }] 
                            }
                        };

                        if (existingBlocks.results.length > 0) {
                            // Update existing block
                            await notion.pages.update({
                                page_id: existingBlocks.results[0].id,
                                properties: timeBlockData
                            });
                            results.updated++;
                            console.log(`Updated: ${title} (${startTime}-${endTime})`);
                        } else {
                            // Create new block
                            await notion.pages.create({
                                parent: { database_id: TIME_BLOCKS_DB_ID },
                                properties: timeBlockData
                            });
                            results.imported++;
                            console.log(`Imported: ${title} (${startTime}-${endTime})`);
                        }

                        results.details.push({
                            title,
                            context,
                            type,
                            time: `${startTime}-${endTime}`,
                            action: existingBlocks.results.length > 0 ? 'updated' : 'imported'
                        });

                    } catch (eventError) {
                        const errorMsg = `Failed to process event "${event.summary || 'Unknown'}": ${eventError.message}`;
                        console.error(errorMsg);
                        results.errors.push(errorMsg);
                    }
                }

            } catch (calendarError) {
                const errorMsg = `Failed to sync calendar ${contextType}: ${calendarError.message}`;
                console.error(errorMsg);
                results.errors.push(errorMsg);
            }
        }

        console.log(`Calendar sync complete: ${results.imported} imported, ${results.updated} updated, ${results.duplicatesSkipped} duplicates skipped, ${results.errors.length} errors`);
        return results;

    } catch (error) {
        const errorMsg = `Critical calendar sync error: ${error.message}`;
        console.error(errorMsg);
        results.errors.push(errorMsg);
        return results;
    }
}

function inferEnergyFromType(type) {
    const energyMap = {
        'Deep Work': 'High',
        'Meeting': 'Med',
        'Admin': 'Med',
        'Events': 'Low',
        'Appointment': 'Med',
        'Travel': 'Low',
        'Routine': 'Med'
    };
    return energyMap[type] || 'Med';
}

// STEP 2: MORNING LOG ANALYSIS
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '06:00',
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
        console.log('STEP 2: Analyzing morning log data...');
        const morningLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        if (morningLogResponse.results.length === 0) {
            console.log('No morning log found for today, using defaults');
            return { ...defaultData, source: 'default' };
        }

        const log = morningLogResponse.results[0].properties;
        const data = { ...defaultData, source: 'morning_log' };
        
        // Parse wake time
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            data.wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        // Parse energy (convert string to number)
        const energyValue = log['Energy']?.select?.name;
        if (energyValue && !isNaN(parseInt(energyValue))) {
            data.energy = parseInt(energyValue);
        }
        
        // Parse all select properties
        data.mood = log['Mood']?.select?.name || 'Steady';
        data.focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        data.socialBattery = log['Social Battery']?.select?.name || 'Full';
        data.bodyStatus = log['Body Status']?.select?.name || 'Normal';
        data.stressLevel = log['Stress Level']?.select?.name || 'Normal';
        data.weatherImpact = log['Weather Impact']?.select?.name || 'None';
        
        // Parse number properties
        data.sleepQuality = log['Sleep Quality']?.number || 7;
        data.sleepHours = log['Sleep Hours']?.number || 7;
        
        console.log('Morning log analysis complete:', {
            energy: data.energy,
            mood: data.mood,
            focus: data.focusCapacity,
            sleep: `${data.sleepHours}h (${data.sleepQuality}/10)`,
            stress: data.stressLevel
        });
        
        return data;
        
    } catch (error) {
        console.error('Error fetching morning log:', error.message);
        return { ...defaultData, source: 'error', error: error.message };
    }
}

// STEP 3: WORK SHIFT DETECTION
async function getWorkShift(today) {
    const homeDay = { 
        isWorkDay: false, 
        isAtSite: false,
        startTime: '09:00', 
        endTime: '17:00', 
        title: 'Home Day'
    };

    if (!calendarEnabled) {
        console.log('STEP 3: Calendar disabled, assuming home day');
        return homeDay;
    }

    try {
        console.log('STEP 3: Detecting work shift...');
        const dayRange = getPacificDateRange(today);
        
        // Check work travel calendar for site work
        const workEvents = await calendar.events.list({
            calendarId: CONTEXT_TYPE_TO_CALENDAR_ID['Work-Travel'],
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
            return homeDay;
        }
        
    } catch (error) {
        console.error('Error checking work shift:', error.message);
        return {
            ...homeDay,
            title: 'Home Day (Calendar Error)',
            error: error.message
        };
    }
}

// STEP 4: INTELLIGENT TASK COLLECTION & SELECTION - SIMPLIFIED FILTERING
async function collectAndSelectTasks(today, morningData) {
    const results = {
        selectedTasks: [],
        deferredTasks: [],
        totalTasks: 0,
        errors: []
    };

    try {
        console.log('STEP 4: Collecting and selecting tasks...');
        console.log(`Today: ${today}, Energy: ${morningData.energy}`);
        
        // SIMPLIFIED: Query tasks using ONLY the Status field
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                property: 'Status',
                select: { does_not_equal: 'Done' }
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 100
        });

        console.log(`Raw task query returned ${tasksResponse.results.length} results`);

        const allTasks = tasksResponse.results.map(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn(`Skipping task with empty title: ${task.id}`);
                    return null;
                }
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || ''; // Keep original case
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                const fixedTime = props['Fixed Time']?.date?.start;
                const carryover = props.Carryover?.checkbox || false;
                const status = props.Status?.select?.name;
                
                // SIMPLIFIED: Only check Status field, ignore Done checkbox
                if (status === 'Done') {
                    console.log(`Skipping completed task: ${title} (Status: ${status})`);
                    return null;
                }
                
                // Calculate urgency score (1-10)
                let urgency = 3; // default
                
                if (dueDate) {
                    const today = new Date();
                    const due = new Date(dueDate);
                    const daysUntilDue = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
                    
                    if (daysUntilDue < 0) urgency = 10; // overdue
                    else if (daysUntilDue === 0) urgency = 9; // due today
                    else if (daysUntilDue === 1) urgency = 8; // due tomorrow
                    else if (daysUntilDue <= 3 && priority === 'High') urgency = 7;
                    else if (daysUntilDue <= 7 && priority === 'High') urgency = 6;
                }
                
                if (priority === 'High' && !dueDate) urgency = 5;
                if (priority === 'Routine') urgency = 3;
                if (carryover) urgency += 1;
                
                // Calculate effort score (1-4)
                let effort = 1;
                if (estimatedTime > 180) effort = 4; // huge
                else if (estimatedTime > 90) effort = 3; // large
                else if (estimatedTime > 30) effort = 2; // medium
                else effort = 1; // small
                
                const taskObj = {
                    id: task.id,
                    title: title.trim(),
                    priority,
                    type: type, // Keep original case for proper matching
                    estimatedTime: Math.max(30, estimatedTime || 30),
                    dueDate,
                    fixedTime,
                    carryover,
                    urgency,
                    effort,
                    routine: priority === 'Routine',
                    used: false,
                    status: status
                };
                
                console.log(`Found active task: "${taskObj.title}" (${taskObj.priority}, Type: "${taskObj.type}", Status: ${taskObj.status}, urgency: ${taskObj.urgency})`);
                return taskObj;
                
            } catch (taskError) {
                console.error('Error processing task:', taskError.message);
                results.errors.push(`Task processing error: ${taskError.message}`);
                return null;
            }
        }).filter(task => task !== null);

        results.totalTasks = allTasks.length;
        console.log(`Filtered to ${allTasks.length} valid active tasks`);

        if (allTasks.length === 0) {
            console.warn('No active tasks found! All tasks may be marked as Done, or database may be empty');
            return results;
        }

        // Calculate available capacity
        const isLowEnergy = morningData.energy <= 5;
        const availableHours = isLowEnergy ? 4 : 6; // conservative capacity
        const availableMinutes = availableHours * 60;
        const bufferMinutes = availableMinutes * 0.2; // 20% buffer
        const workingCapacity = availableMinutes - bufferMinutes;

        // Smart task selection
        let usedCapacity = 0;
        
        for (const task of allTasks) {
            if (usedCapacity + task.estimatedTime <= workingCapacity) {
                results.selectedTasks.push(task);
                usedCapacity += task.estimatedTime;
                task.used = true;
                console.log(`Selected task: "${task.title}" (${task.priority}, Type: "${task.type}")`);
            } else {
                results.deferredTasks.push(task);
                console.log(`Deferred task: "${task.title}" (${task.priority}) - capacity exceeded`);
            }
        }

        console.log(`Task selection complete: ${results.selectedTasks.length} selected, ${results.deferredTasks.length} deferred`);
        console.log(`Capacity utilization: ${Math.round(usedCapacity/60 * 10)/10}/${availableHours} hours`);

        return results;

    } catch (error) {
        const errorMsg = `Task collection failed: ${error.message}`;
        console.error(errorMsg);
        console.error('Full error:', error);
        results.errors.push(errorMsg);
        return results;
    }
}

// STEP 5: INTELLIGENT SCHEDULE CREATION - FIXED TASK CLASSIFICATION
function createIntelligentSchedule(wakeTime, workShift, selectedTasks, morningData) {
    console.log('STEP 5: Creating intelligent schedule with PROPER task classification...');
    
    const schedule = [];
    let currentTime = wakeTime;
    
    // Energy state analysis
    const isLowEnergy = morningData.energy <= 5;
    const isScatteredFocus = morningData.focusCapacity === 'Scattered';
    const isDrained = morningData.mood === 'Drained' || morningData.socialBattery === 'Drained';
    const isAchy = morningData.bodyStatus === 'Achy' || morningData.bodyStatus === 'Sick';
    const needsRecovery = morningData.sleepHours < 6;
    const isStressed = morningData.stressLevel === 'Maxed Out';
    const canDeepFocus = morningData.focusCapacity === 'Sharp' && morningData.energy >= 7;

    // Adaptive parameters
    const blockDuration = isLowEnergy || isDrained || isAchy ? 45 : (canDeepFocus ? 90 : 60);
    const breakFrequency = isLowEnergy || isStressed ? 60 : 90;
    let consecutiveWorkMinutes = 0;

    // Create a copy of tasks that can be shared between morning and afternoon
    const availableTasks = selectedTasks.map(t => ({...t, used: false}));
    
    console.log(`Available tasks for scheduling: ${availableTasks.length}`);

    // FIXED: Smart task classification based on ACTUAL Notion database values
    function classifyTaskType(task) {
        if (!task) return { blockType: 'Deep Work', energyReq: 'Med' }; // Default to deep work when no task
        
        const taskType = task.type || ''; // Keep original case - your database has "Deep Work", "Admin", etc.
        const taskPriority = task.priority?.toLowerCase() || '';
        
        console.log(`Classifying task: "${task.title}" with Type: "${taskType}" and Priority: "${taskPriority}"`);
        
        // Direct mapping from your Notion database Type field
        // Your actual database values: "Errand", "Creative", "Admin", "Deep Work", "Meeting"
        switch (taskType) {
            case 'Admin':
                return {
                    blockType: 'Admin',
                    energyReq: isLowEnergy ? 'Low' : 'Med'
                };
            case 'Deep Work':
                return {
                    blockType: 'Deep Work',
                    energyReq: isLowEnergy ? 'Med' : 'High'
                };
            case 'Creative':
                return {
                    blockType: 'Deep Work', // Creative work is still deep work
                    energyReq: isLowEnergy ? 'Med' : 'High'
                };
            case 'Meeting':
                return {
                    blockType: 'Meeting',
                    energyReq: 'Med'
                };
            case 'Errand':
                return {
                    blockType: 'Admin', // Errands are admin-level tasks
                    energyReq: 'Med'
                };
            default:
                // CRITICAL: Tasks with NO Type field default to Deep Work
                // This catches all your project work that doesn't have Type set
                console.log(`Task "${task.title}" has no Type field - defaulting to Deep Work`);
                
                // Check if it's routine priority
                if (taskPriority === 'routine') {
                    return {
                        blockType: 'Routine',
                        energyReq: 'Med'
                    };
                }
                
                // Default for untyped tasks: Deep Work (project work)
                return {
                    blockType: 'Deep Work',
                    energyReq: isLowEnergy ? 'Med' : 'High'
                };
        }
    }

    // Smart task assignment function - UPDATED
    function assignBestTask(preferredBlockType) {
        const unusedTasks = availableTasks.filter(t => !t.used);
        if (unusedTasks.length === 0) return null;
        
        let selectedTask = null;
        
        // Try to match preferred block type first
        if (preferredBlockType === 'Deep Work' && canDeepFocus) {
            // Look for high urgency tasks or any project work
            selectedTask = unusedTasks.filter(t => {
                const classification = classifyTaskType(t);
                return classification.blockType === 'Deep Work' && t.urgency >= 6;
            }).sort((a, b) => b.urgency - a.urgency)[0];
            
            // If no high urgency deep work, take any deep work task
            if (!selectedTask) {
                selectedTask = unusedTasks.filter(t => {
                    const classification = classifyTaskType(t);
                    return classification.blockType === 'Deep Work';
                }).sort((a, b) => b.urgency - a.urgency)[0];
            }
