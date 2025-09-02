return timeToMinutes(timeStr) + minutes;
}

// ═══════════════════════════════════════════════════════════════════
// 🔄 TWO-WAY SYNC FUNCTIONALITY
// ═══════════════════════════════════════════════════════════════════

async function performTwoWaySync(date) {
    console.log('🔄 Starting two-way calendar sync...');
    
    try {
        // Step 1: Sync Google Calendar events to Notion (missing time blocks)
        const gcalToNotionResult = await syncGoogleCalendarToNotion(date);
        
        // Step 2: Sync Notion time blocks to Google Calendar (missing events)
        const notionToGcalResult = await syncNotionToGoogleCalendar(date);
        
        // Step 3: Update existing items where modifications detected
        const updateResult = await syncModifiedItems(date);
        
        return {
            googleToNotion: gcalToNotionResult,
            notionToGoogle: notionToGcalResult,
            updates: updateResult,
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('Two-way sync failed:', error);
        return {
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

async function syncGoogleCalendarToNotion(date) {
    console.log('📅→📝 Syncing Google Calendar events to Notion...');
    
    let createdBlocks = 0;
    let skippedEvents = 0;
    const errors = [];
    
    try {
        // Check all relevant calendars for new events
        for (const [blockType, calendarId] of Object.entries(BLOCK_TYPE_TO_CALENDAR_ID)) {
            try {
                const events = await calendar.events.list({
                    calendarId: calendarId,
                    timeMin: `${date}T00:00:00-07:00`,
                    timeMax: `${date}T23:59:59-07:00`,
                    singleEvents: true,
                    orderBy: 'startTime'
                });
                
                for (const event of events.data.items || []) {
                    // Skip if this event already has a corresponding Notion block
                    const existingBlock = await findNotionBlockByGcalId(event.id);
                    if (existingBlock) {
                        skippedEvents++;
                        continue;
                    }
                    
                    // Skip all-day events or events without proper time
                    if (!event.start?.dateTime || !event.end?.dateTime) {
                        skippedEvents++;
                        continue;
                    }
                    
                    // Create Notion time block from calendar event
                    const startTime = new Date(event.start.dateTime);
                    const endTime = new Date(event.end.dateTime);
                    
                    await notion.pages.create({
                        parent: { database_id: TIME_BLOCKS_DB_ID },
                        properties: {
                            Title: { 
                                title: [{ 
                                    text: { 
                                        content: event.summary || 'Untitled Event' 
                                    } 
                                }] 
                            },
                            'Block Type': { 
                                select: { 
                                    name: capitalizeBlockType(blockType) 
                                } 
                            },
                            'Energy Requirements': { 
                                select: { 
                                    name: 'Medium' 
                                } 
                            },
                            Status: { 
                                select: { 
                                    name: 'Active' 
                                } 
                            },
                            'Start Time': { 
                                date: { 
                                    start: startTime.toISOString() 
                                } 
                            },
                            'End Time': { 
                                date: { 
                                    start: endTime.toISOString() 
                                } 
                            },
                            'GCal ID': {
                                rich_text: [{
                                    text: {
                                        content: event.id
                                    }
                                }]
                            }
                        }
                    });
                    
                    createdBlocks++;
                    console.log(`✅ Created Notion block for: ${event.summary}`);
                }
                
            } catch (error) {
                console.error(`Error syncing calendar ${calendarId}:`, error.message);
                errors.push({ calendarId, error: error.message });
            }
        }
        
        return {
            success: true,
            updated: updatedItems,
            errors: errors
        };
        
    } catch (error) {
        console.error('Modified items sync failed:', error);
        return {
            success: false,
            error: error.message,
            updated: updatedItems
        };
    }
}

async function findNotionBlockByGcalId(gcalId) {
    try {
        const response = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'GCal ID',
                rich_text: {
                    equals: gcalId
                }
            }
        });
        
        return response.results.length > 0 ? response.results[0] : null;
    } catch (error) {
        console.error('Error finding Notion block:', error);
        return null;
    }
}

function capitalizeBlockType(blockType) {
    const typeMap = {
        'deep-work': 'Deep Work',
        'creative': 'Creative',
        'admin': 'Admin',
        'meeting': 'Meeting',
        'riley-time': 'Riley Time',
        'personal': 'Personal',
        'break': 'Break',
        'routine': 'Routine'
    };
    return typeMap[blockType] || blockType.charAt(0).toUpperCase() + blockType.slice(1);
}
            created: createdBlocks,
            skipped: skippedEvents,
            errors: errors
        };
        
    } catch (error) {
        console.error('Google Calendar to Notion sync failed:', error);
        return {
            success: false,
            error: error.message,
            created: createdBlocks,
            skipped: skippedEvents
        };
    }
}

async function syncNotionToGoogleCalendar(date) {
    console.log('📝→📅 Syncing Notion blocks to Google Calendar...');
    
    let createdEvents = 0;
    let skippedBlocks = 0;
    const errors = [];
    
    try {
        // Get all time blocks for the day without GCal IDs
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Start Time',
                        date: {
                            on_or_after: `${date}T00:00:00.000Z`,
                            on_or_before: `${date}T23:59:59.999Z`
                        }
                    },
                    {
                        or: [
                            {
                                property: 'GCal ID',
                                rich_text: {
                                    is_empty: true
                                }
                            },
                            {
                                property: 'GCal ID',
                                rich_text: {
                                    equals: ''
                                }
                            }
                        ]
                    }
                ]
            }
        });
        
        for (const block of timeBlocks.results) {
            try {
                const title = block.properties.Title?.title[0]?.text?.content || 'Untitled';
                const blockType = block.properties['Block Type']?.select?.name?.toLowerCase().replace(/\s+/g, '-') || 'personal';
                const startTime = block.properties['Start Time']?.date?.start;
                const endTime = block.properties['End Time']?.date?.start;
                
                if (!startTime || !endTime) {
                    skippedBlocks++;
                    continue;
                }
                
                // Skip work blocks - externally managed
                if (blockType === 'work') {
                    skippedBlocks++;
                    continue;
                }
                
                const calendarEvent = await createGoogleCalendarEvent({
                    title: title,
                    start: new Date(startTime).toTimeString().split(' ')[0].substring(0, 5),
                    duration: Math.round((new Date(endTime) - new Date(startTime)) / 60000),
                    type: blockType,
                    energy: block.properties['Energy Requirements']?.select?.name || 'Medium'
                }, date);
                
                if (calendarEvent) {
                    // Update the Notion block with the calendar event ID
                    await notion.pages.update({
                        page_id: block.id,
                        properties: {
                            'GCal ID': {
                                rich_text: [{
                                    text: {
                                        content: calendarEvent.eventId
                                    }
                                }]
                            }
                        }
                    });
                    
                    createdEvents++;
                    console.log(`✅ Created calendar event for: ${title}`);
                }
                
            } catch (error) {
                console.error(`Error creating calendar event for block:`, error.message);
                errors.push({ blockTitle: title, error: error.message });
                skippedBlocks++;
            }
        }
        
        return {
            success: true,
            created: createdEvents,
            skipped: skippedBlocks,
            errors: errors
        };
        
    } catch (error) {
        console.error('Notion to Google Calendar sync failed:', error);
        return {
            success: false,
            error: error.message,
            created: createdEvents,
            skipped: skippedBlocks
        };
    }
}

async function syncModifiedItems(date) {
    console.log('🔄 Checking for modified items to sync...');
    
    // This is a simplified version - in a full implementation, you'd track
    // modification timestamps and sync changes bidirectionally
    
    let updatedItems = 0;
    const errors = [];
    
    try {
        // Get all time blocks with GCal IDs for the day
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Start Time',
                        date: {
                            on_or_after: `${date}T00:00:00.000Z`,
                            on_or_before: `${date}T23:59:59.999Z`
                        }
                    },
                    {
                        property: 'GCal ID',
                        rich_text: {
                            is_not_empty: true
                        }
                    }
                ]
            }
        });
        
        // For each block, check if the corresponding calendar event still exists
        // and has the same details - if not, update accordingly
        for (const block of timeBlocks.results) {
            const gcalId = block.properties['GCal ID']?.rich_text[0]?.text?.content;
            if (!gcalId) continue;
            
            try {
                // Find which calendar this event belongs to
                const blockType = block.properties['Block Type']?.select?.name?.toLowerCase().replace(/\s+/g, '-') || 'personal';
                const calendarId = BLOCK_TYPE_TO_CALENDAR_ID[blockType] || BLOCK_TYPE_TO_CALENDAR_ID['personal'];
                
                // Try to get the event from Google Calendar
                const event = await calendar.events.get({
                    calendarId: calendarId,
                    eventId: gcalId
                });
                
                // Compare details and update if necessary
                const notionTitle = block.properties.Title?.title[0]?.text?.content || '';
                const gcalTitle = event.data.summary || '';
                
                if (notionTitle !== gcalTitle) {
                    // Title changed in calendar - update Notion
                    await notion.pages.update({
                        page_id: block.id,
                        properties: {
                            Title: {
                                title: [{
                                    text: {
                                        content: gcalTitle
                                    }
                                }]
                            }
                        }
                    });
                    updatedItems++;
                    console.log(`✅ Updated Notion block title: ${gcalTitle}`);
                }
                
            } catch (error) {
                // Event might be deleted - could archive the Notion block
                if (error.code === 404) {
                    console.log(`Calendar event ${gcalId} not found - archiving Notion block`);
                    await notion.pages.update({
                        page_id: block.id,
                        archived: true
                    });
                    updatedItems++;
                } else {
                    errors.push({ gcalId, error: error.message });
                }
            }
        }
        
        return {
            success: true,
            const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar integration with WRITE permissions
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar'  // Added WRITE permissions
    ],
});

const calendar = google.calendar({ version: 'v3', auth });

// Calendar routing based on your Python script
const BLOCK_TYPE_TO_CALENDAR_ID = {
    'deep-work': '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com',
    'creative': 'shamilarae@gmail.com',
    'admin': 'ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com', 
    'meeting': '80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com',
    'riley-time': 'family13053487624784455294@group.calendar.google.com',
    'personal': 'shamilarae@gmail.com',
    'break': 'shamilarae@gmail.com',
    'routine': 'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com'
};

// Work schedule configuration
const WORK_SCHEDULE = {
    calendarId: 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
    startDate: '2025-08-28',
    endDate: '2025-09-10',
    dailyStart: '05:30',
    dailyEnd: '17:30'
};

// Riley's school schedule
const RILEY_SCHEDULE = {
    schoolStart: '08:20',
    schoolEnd: '15:30',
    schoolDays: [1, 2, 3, 4, 5] // Monday-Friday
};

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';

        if (action === 'create') {
            console.log('Creating intelligent schedule with enhanced logic...');
            await createIntelligentSchedule(today);
        } else if (action === 'sync') {
            console.log('Performing two-way calendar sync...');
            const syncResult = await performTwoWaySync(today);
            return res.status(200).json({
                message: 'Sync completed',
                result: syncResult,
                timestamp: new Date().toISOString()
            });
        }

        const schedule = await getCurrentSchedule(today);

        const now = new Date();
        const response = {
            schedule: schedule,
            debug: {
                totalBlocks: schedule.length,
                creationAttempted: action === 'create',
                lastCreationResult: global.lastCreationResult || null,
                timestamp: now.toISOString()
            },
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
            })
        };

        res.status(200).json(response);

    } catch (error) {
        console.error('Timeline API Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate timeline',
            details: error.message
        });
    }
};

async function getCurrentSchedule(today) {
    try {
        console.log(`Getting schedule for ${today}...`);
        
        const todayStart = `${today}T00:00:00.000Z`;
        const tomorrowDate = new Date(today + 'T00:00:00.000Z');
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrowEnd = tomorrowDate.toISOString().split('T')[0] + 'T23:59:59.999Z';
        
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: todayStart,
                    on_or_before: tomorrowEnd
                }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 100
        });

        console.log(`Found ${timeBlocks.results.length} blocks in Notion for ${today}`);

        if (timeBlocks.results.length === 0) {
            console.log('No blocks found, returning empty schedule');
            return [];
        }

        const schedule = timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled';
            const blockType = block.properties['Block Type']?.select?.name || 'admin';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            if (!startTime) {
                console.log(`Block "${title}" has no start time, skipping`);
                return null;
            }

            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
            const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

            const pacificMidnight = new Date(`${today}T00:00:00-07:00`);
            const nextDayMidnight = new Date(`${today}T23:59:59-07:00`);
            
            if (startPacific < pacificMidnight || startPacific > nextDayMidnight) {
                return null;
            }

            const formattedBlock = {
                time: `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}`,
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy • ${blockType}`
            };

            return formattedBlock;
        }).filter(block => block !== null);

        console.log(`Returning ${schedule.length} formatted blocks for today`);
        return schedule;

    } catch (error) {
        console.error('Failed to get schedule:', error.message);
        return [];
    }
}

async function isWorkDay(date) {
    const dateStr = date || new Date().toISOString().split('T')[0];
    return dateStr >= WORK_SCHEDULE.startDate && dateStr <= WORK_SCHEDULE.endDate;
}

async function isRileySchoolDay(date) {
    const checkDate = new Date(date + 'T00:00:00-07:00');
    const dayOfWeek = checkDate.getDay();
    return RILEY_SCHEDULE.schoolDays.includes(dayOfWeek);
}

function calculateOptimalSleep(wakeTime, targetHours = 7.5) {
    const [wakeHour, wakeMin] = wakeTime.split(':').map(Number);
    const wakeMinutes = wakeHour * 60 + wakeMin;
    const sleepMinutes = wakeMinutes - (targetHours * 60);
    
    let bedHour, bedMin;
    if (sleepMinutes >= 0) {
        bedHour = Math.floor(sleepMinutes / 60);
        bedMin = sleepMinutes % 60;
    } else {
        // Previous day
        const prevDayMinutes = sleepMinutes + (24 * 60);
        bedHour = Math.floor(prevDayMinutes / 60);
        bedMin = prevDayMinutes % 60;
    }
    
    return `${bedHour.toString().padStart(2, '0')}:${bedMin.toString().padStart(2, '0')}`;
}

async function getWorkShift(date) {
    try {
        const workCalendarId = WORK_SCHEDULE.calendarId;
        
        const events = await calendar.events.list({
            calendarId: workCalendarId,
            timeMin: `${date}T00:00:00-07:00`,
            timeMax: `${date}T23:59:59-07:00`,
            singleEvents: true,
            orderBy: 'startTime'
        });

        if (events.data.items && events.data.items.length > 0) {
            return {
                isWorkDay: true,
                startTime: WORK_SCHEDULE.dailyStart,
                endTime: WORK_SCHEDULE.dailyEnd,
                title: 'Work Shift'
            };
        }
        
        return { isWorkDay: false };
    } catch (error) {
        console.error('Error checking work schedule:', error.message);
        return { isWorkDay: false };
    }
}

async function createIntelligentSchedule(today) {
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        page_size: 1
    });

    let wakeTime = '04:30';
    let energy = 7;
    let mood = 'Good';
    let focusCapacity = 'Normal';
    let socialBattery = 'Full';
    
    if (morningLogResponse.results.length > 0) {
        const log = morningLogResponse.results[0].properties;
        
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            const wake = new Date(wakeTimeRaw);
            const pacificTime = new Date(wake.getTime() - (7 * 60 * 60 * 1000));
            wakeTime = `${pacificTime.getUTCHours().toString().padStart(2, '0')}:${pacificTime.getUTCMinutes().toString().padStart(2, '0')}`;
        }
        
        energy = log['Energy']?.number || 7;
        mood = log['Mood']?.select?.name || 'Good';
        focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        socialBattery = log['Social Battery']?.select?.name || 'Full';
    }

    console.log(`Creating intelligent schedule: Wake ${wakeTime}, Energy ${energy}, Focus ${focusCapacity}`);

    // Get tasks with priority for routine tasks
    const tasks = await getTodaysTasks(today);
    const routineTasks = tasks.filter(t => t.routine || t.priority === 'Routine');
    console.log(`Found ${tasks.length} tasks total, ${routineTasks.length} routine tasks`);

    const workShift = await getWorkShift(today);
    const isSchoolDay = await isRileySchoolDay(today);
    console.log(`Work day: ${workShift.isWorkDay}, School day: ${isSchoolDay}`);

    await clearTodayBlocks(today);

    let schedule = [];
    
    if (workShift.isWorkDay) {
        // Work day schedule - NO Riley blocks
        schedule = createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity);
    } else {
        // Home day schedule - WITH Riley blocks
        schedule = createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity, isSchoolDay);
    }

    // Calculate optimal bedtime
    const targetSleep = workShift.isWorkDay ? 6.5 : 7.5;
    const suggestedBedtime = calculateOptimalSleep(wakeTime, targetSleep);

    let successCount = 0;
    let failedBlocks = [];
    let calendarEvents = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            
            const startUTC = new Date(`${today}T${block.start}:00.000-07:00`);
            const endUTC = new Date(`${today}T${endTime}:00.000-07:00`);
            
            // Create time block in Notion
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: block.type } },
                    'Energy Requirements': { select: { name: block.energy } },
                    Status: { select: { name: 'Active' } },
                    'Start Time': { date: { start: startUTC.toISOString() } },
                    'End Time': { date: { start: endUTC.toISOString() } }
                }
            });
            
            successCount++;

            // Create Google Calendar event
            try {
                const calendarEvent = await createGoogleCalendarEvent(block, today);
                if (calendarEvent) {
                    calendarEvents.push({
                        blockTitle: block.title,
                        calendarId: calendarEvent.calendarId,
                        eventId: calendarEvent.eventId,
                        status: 'success'
                    });

                    // Update time block with Google Calendar ID for sync tracking
                    await notion.pages.update({
                        page_id: timeBlockResponse.id,
                        properties: {
                            'GCal ID': { 
                                rich_text: [{ 
                                    text: { 
                                        content: calendarEvent.eventId 
                                    } 
                                }] 
                            }
                        }
                    });
                }
            } catch (calError) {
                console.error(`Failed to create calendar event for ${block.title}:`, calError.message);
                calendarEvents.push({
                    blockTitle: block.title,
                    status: 'failed',
                    error: calError.message
                });
            }
            
        } catch (error) {
            failedBlocks.push({
                title: block.title,
                error: error.message,
                time: block.start
            });
        }
    }
    
    global.lastCreationResult = {
        success: successCount,
        failed: failedBlocks.length,
        failedBlocks: failedBlocks,
        calendarEvents: calendarEvents,
        wakeTime: wakeTime,
        suggestedBedtime: suggestedBedtime,
        targetSleep: `${targetSleep}h`,
        workDay: workShift.isWorkDay,
        schoolDay: isSchoolDay,
        workShift: workShift.isWorkDay ? `${workShift.startTime}-${workShift.endTime}` : 'Home Day',
        energy: energy,
        mood: mood,
        focus: focusCapacity,
        socialBattery: socialBattery,
        tasksCount: tasks.length,
        routineTasksCount: routineTasks.length,
        timestamp: new Date().toISOString()
    };

    console.log(`Schedule created: ${successCount} blocks, ${calendarEvents.filter(e => e.status === 'success').length} calendar events`);
}

function createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity) {
    console.log('📋 Creating work day schedule (no family time)');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    // Quick morning routine at work camp
    schedule.push({
        title: 'Morning Routine (Work Camp)',
        start: currentTime,
        duration: 30,
        type: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // PRIORITIZE routine tasks before work if time allows
    if (routineTasks.length > 0 && getMinutesBetween(currentTime, '05:30') >= 30) {
        const availableTime = Math.min(getMinutesBetween(currentTime, '05:30'), routineTasks.length * 15);
        schedule.push({
            title: `Quick Routine Tasks (${routineTasks.length})`,
            start: currentTime,
            duration: availableTime,
            type: 'Routine',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, availableTime);
    } else {
        // NO TASKS: Fill remaining pre-work time with planning/prep
        const preWorkTime = getMinutesBetween(currentTime, '05:30');
        if (preWorkTime >= 15) {
            schedule.push({
                title: 'Work Prep & Planning',
                start: currentTime,
                duration: preWorkTime,
                type: 'Admin',
                energy: 'Medium'
            });
        }
    }
    
    // Work shift (external management) - DON'T CREATE TIME BLOCKS FOR THIS
    // This is managed externally via the work calendar
    
    // Post-work recovery blocks
    let postWorkTime = addMinutes(workShift.endTime, 0);
    
    schedule.push({
        title: 'Post-Work Decompress',
        start: postWorkTime,
        duration: 60,
        type: 'Break',
        energy: 'Low'
    });
    postWorkTime = addMinutes(postWorkTime, 60);
    
    schedule.push({
        title: 'Personal Time & Recovery',
        start: postWorkTime,
        duration: 120,
        type: 'Personal',
        energy: 'Low'
    });
    postWorkTime = addMinutes(postWorkTime, 120);
    
    schedule.push({
        title: 'Wind Down & Sleep Prep',
        start: postWorkTime,
        duration: 90,
        type: 'Personal',
        energy: 'Low'
    });
    
    return schedule;
}

function createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity, isSchoolDay) {
    console.log('🏠 Creating home day schedule (with family time)');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine & Recovery',
        start: currentTime,
        duration: 60,
        type: 'Personal',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // CRITICAL: Routine tasks MUST be completed before 10:00 AM
    if (routineTasks.length > 0) {
        const routineEndTime = Math.min(
            addMinutesToTime(currentTime, routineTasks.length * 30),
            timeToMinutes('10:00')
        );
        
        const routineDuration = getMinutesBetween(currentTime, minutesToTime(routineEndTime));
        
        schedule.push({
            title: `Morning Routine Tasks (${routineTasks.length}) - PRIORITY`,
            start: currentTime,
            duration: routineDuration,
            type: 'Routine',
            energy: 'Medium',
            priority: 'HIGH'
        });
        currentTime = addMinutes(currentTime, routineDuration);
    } else {
        // NO ROUTINE TASKS: Create morning admin block before 10 AM
        const availableTime = Math.min(getMinutesBetween(currentTime, '10:00'), 90);
        if (availableTime >= 30) {
            schedule.push({
                title: 'Morning Admin & Planning',
                start: currentTime,
                duration: availableTime,
                type: 'Admin',
                energy: 'Medium'
            });
            currentTime = addMinutes(currentTime, availableTime);
        }
    }
    
    // Main work blocks based on energy - FILL THE DAY WITH PRODUCTIVE BLOCKS
    if (energy >= 8 && focusCapacity === 'Sharp') {
        // High energy, sharp focus: Deep work blocks
        schedule.push({
            title: 'Deep Work Block 1',
            start: currentTime,
            duration: 120,
            type: 'Deep Work',
            energy: 'High'
        });
        currentTime = addMinutes(currentTime, 120);
        
        schedule.push({
            title: 'Break',
            start: currentTime,
            duration: 15,
            type: 'Break',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push({
            title: 'Deep Work Block 2',
            start: currentTime,
            duration: 90,
            type: 'Deep Work',
            energy: 'High'
        });
        currentTime = addMinutes(currentTime, 90);
        
    } else if (energy >= 6) {
        // Medium-high energy: Creative work focus
        schedule.push({
            title: 'Creative/Project Work Block',
            start: currentTime,
            duration: 120,
            type: 'Creative',
            energy: energy >= 7 ? 'High' : 'Medium'
        });
        currentTime = addMinutes(currentTime, 120);
        
        schedule.push({
            title: 'Admin Tasks',
            start: currentTime,
            duration: 60,
            type: 'Admin',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 60);
        
    } else if (energy >= 4) {
        // Lower energy: Admin and light creative work
        schedule.push({
            title: 'Admin Tasks Block',
            start: currentTime,
            duration: 90,
            type: 'Admin',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push({
            title: 'Light Creative Work',
            start: currentTime,
            duration: 60,
            type: 'Creative',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 60);
        
    } else {
        // Very low energy: Light admin only
        schedule.push({
            title: 'Light Admin & Organization',
            start: currentTime,
            duration: 120,
            type: 'Admin',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 120);
    }
    
    // Lunch break
    if (getMinutesBetween('12:00', currentTime) > 0) {
        currentTime = '12:00';
    }
    
    schedule.push({
        title: 'Lunch Break',
        start: currentTime,
        duration: 60,
        type: 'Break',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Afternoon productive block
    if (energy >= 6) {
        schedule.push({
            title: 'Afternoon Project Work',
            start: currentTime,
            duration: 90,
            type: 'Creative',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 90);
    } else {
        schedule.push({
            title: 'Afternoon Admin',
            start: currentTime,
            duration: 60,
            type: 'Admin',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 60);
    }
    
    // Riley time - CRITICAL: Respect school schedule
    if (isSchoolDay) {
        // Riley gets home at 3:30, schedule time after that
        const rileyStartTime = Math.max(timeToMinutes(currentTime), timeToMinutes('15:30'));
        schedule.push({
            title: 'Riley Time (After School)',
            start: minutesToTime(rileyStartTime),
            duration: 120,
            type: 'Riley Time',
            energy: 'Medium'
        });
        currentTime = addMinutes(minutesToTime(rileyStartTime), 120);
    } else {
        // Weekend/holiday - longer family time
        schedule.push({
            title: 'Riley Family Time',
            start: currentTime,
            duration: 180,
            type: 'Riley Time',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 180);
    }
    
    // Evening personal time
    schedule.push({
        title: 'Dinner & Family Time',
        start: currentTime,
        duration: 90,
        type: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 90);
    
    schedule.push({
        title: 'Evening Personal Time',
        start: currentTime,
        duration: 60,
        type: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    schedule.push({
        title: 'Wind Down & Sleep Prep',
        start: currentTime,
        duration: 60,
        type: 'Personal',
        energy: 'Low'
    });
    
    return schedule;
}

async function createGoogleCalendarEvent(block, date) {
    try {
        // Skip work blocks - externally managed
        if (block.type === 'Work') return null;
        
        const blockTypeKey = block.type.toLowerCase().replace(/\s+/g, '-');
        const calendarId = BLOCK_TYPE_TO_CALENDAR_ID[blockTypeKey] || BLOCK_TYPE_TO_CALENDAR_ID['personal'];
        
        const startTime = `${date}T${block.start}:00.000-07:00`;
        const endTime = `${date}T${addMinutes(block.start, block.duration)}:00.000-07:00`;
        
        const event = {
            summary: block.title,
            description: `Energy: ${block.energy}\nAuto-created by AI Scheduler\n\nType: ${block.type}`,
            start: {
                dateTime: startTime,
                timeZone: 'America/Vancouver'
            },
            end: {
                dateTime: endTime,
                timeZone: 'America/Vancouver'
            },
            colorId: getCalendarColorId(blockTypeKey)
        };
        
        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event
        });
        
        return {
            eventId: response.data.id,
            calendarId: calendarId
        };
        
    } catch (error) {
        console.error(`Calendar event creation failed for ${block.title}:`, error.message);
        throw error;
    }
}

function getCalendarColorId(blockType) {
    const colorMap = {
        'deep-work': '9', // Blue
        'creative': '5', // Yellow  
        'admin': '8', // Gray
        'meeting': '11', // Red
        'riley-time': '10', // Green
        'personal': '1', // Purple
        'break': '7', // Cyan
        'routine': '6' // Orange
    };
    return colorMap[blockType] || '1';
}

async function getTodaysTasks(today) {
    try {
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

        return tasksResponse.results.map(task => {
            const props = task.properties;
            const title = props.Name?.title[0]?.text?.content || 'Untitled Task';
            const priority = props['Priority Level']?.select?.name || 'Medium';
            const due = props['Due Date']?.date?.start;
            const type = props.Type?.select?.name || 'Admin';
            const estimatedTime = props['Estimated Duration']?.number || 30;
            const autoSchedule = props['Auto-Schedule']?.checkbox || false;
            
            // Check if it's a routine task
            const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
            
            return {
                title,
                priority,
                due,
                type: type.toLowerCase(),
                routine,
                estimatedTime,
                autoSchedule,
                id: task.id
            };
        });
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        return [];
    }
}

async function clearTodayBlocks(today) {
    try {
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: `${today}T00:00:00.000Z`,
                    on_or_before: `${today}T23:59:59.999Z`
                }
            },
            page_size: 100
        });

        for (const block of existing.results) {
            try {
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
            } catch (error) {
                console.error(`Failed to archive block ${block.id}:`, error.message);
            }
        }
    } catch (error) {
        console.error('Error clearing blocks:', error.message);
    }
}

// Utility functions
function addMinutes(timeStr, minutes) {
    const [hours, mins] = timeStr.split(':').map(Number);
    const totalMins = hours * 60 + mins + minutes;
    const newHours = Math.floor(totalMins / 60) % 24;
    const newMins = totalMins % 60;
    return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

function getMinutesBetween(startTime, endTime) {
    const [startHours, startMins] = startTime.split(':').map(Number);
    const [endHours, endMins] = endTime.split(':').map(Number);
    const startTotalMins = startHours * 60 + startMins;
    const endTotalMins = endHours * 60 + endMins;
    return endTotalMins - startTotalMins;
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

function addMinutesToTime(timeStr, minutes) {
    return timeToMinutes(timeStr) + minutes;
}
