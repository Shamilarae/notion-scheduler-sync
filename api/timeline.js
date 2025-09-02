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
        'https://www.googleapis.com/auth/calendar'
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

    const tasks = await getTodaysTasks(today);
    const routineTasks = tasks.filter(t => t.routine || t.priority === 'Routine');
    console.log(`Found ${tasks.length} tasks total, ${routineTasks.length} routine tasks`);

    const workShift = await getWorkShift(today);
    console.log(`Work day: ${workShift.isWorkDay}`);

    await clearTodayBlocks(today);

    let schedule = [];
    
    if (workShift.isWorkDay) {
        schedule = createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity);
    } else {
        schedule = createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity);
    }

    let successCount = 0;
    let failedBlocks = [];
    let calendarEvents = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            
            const startUTC = new Date(`${today}T${block.start}:00.000-07:00`);
            const endUTC = new Date(`${today}T${endTime}:00.000-07:00`);
            
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
        workDay: workShift.isWorkDay,
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
    console.log('Creating work day schedule (no family time)');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    schedule.push({
        title: 'Morning Routine (Work Camp)',
        start: currentTime,
        duration: 30,
        type: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
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

function createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity) {
    console.log('Creating home day schedule (with family time)');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    schedule.push({
        title: 'Morning Routine & Recovery',
        start: currentTime,
        duration: 60,
        type: 'Personal',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 60);
    
    if (routineTasks.length > 0) {
        const routineDuration = Math.min(getMinutesBetween(currentTime, '10:00'), routineTasks.length * 30);
        
        schedule.push({
            title: `Morning Routine Tasks (${routineTasks.length}) - PRIORITY`,
            start: currentTime,
            duration: routineDuration,
            type: 'Routine',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, routineDuration);
    } else {
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
    
    if (energy >= 8 && focusCapacity === 'Sharp') {
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
        schedule.push({
            title: 'Light Admin & Organization',
            start: currentTime,
            duration: 120,
            type: 'Admin',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 120);
    }
    
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
    
    schedule.push({
        title: 'Riley Time (After School)',
        start: Math.max(currentTime, '15:30') >= currentTime ? Math.max(currentTime, '15:30') : currentTime,
        duration: 120,
        type: 'Riley Time',
        energy: 'Medium'
    });
    currentTime = addMinutes(Math.max(currentTime, '15:30'), 120);
    
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
            }
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
