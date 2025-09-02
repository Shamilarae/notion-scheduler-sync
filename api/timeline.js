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

// Timezone utilities
const PACIFIC_OFFSET = -7; // PDT is UTC-7, PST is UTC-8 - adjust seasonally

function pacificDateToUTC(pacificDateStr, timeStr) {
    // Convert Pacific date/time to UTC
    const pacificDateTime = `${pacificDateStr}T${timeStr}:00.000`;
    const utcDate = new Date(pacificDateTime);
    utcDate.setUTCHours(utcDate.getUTCHours() - PACIFIC_OFFSET);
    return utcDate;
}

function utcToPacificTime(utcDateStr) {
    // Convert UTC datetime to Pacific time string
    const utcDate = new Date(utcDateStr);
    const pacificDate = new Date(utcDate.getTime() + (PACIFIC_OFFSET * 60 * 60 * 1000));
    const hours = pacificDate.getUTCHours();
    const minutes = pacificDate.getUTCMinutes();
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    // Convert Pacific date + time to UTC ISO string
    const pacificDateTime = new Date(`${pacificDateStr}T${pacificTimeStr}:00.000`);
    const utcDateTime = new Date(pacificDateTime.getTime() - (PACIFIC_OFFSET * 60 * 60 * 1000));
    return utcDateTime.toISOString();
}

function getPacificDateRange(pacificDateStr) {
    // Get UTC range that covers the full Pacific day
    const pacificStartUTC = pacificTimeToUTC(pacificDateStr, '00:00');
    const pacificEndUTC = pacificTimeToUTC(pacificDateStr, '23:59');
    return {
        start: pacificStartUTC,
        end: pacificEndUTC
    };
}

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
        console.log(`Getting schedule for ${today} (Pacific date)...`);
        
        // Get the UTC range that covers the full Pacific day
        const pacificDayRange = getPacificDateRange(today);
        
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: pacificDayRange.start,
                    on_or_before: pacificDayRange.end
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

            // Convert UTC times to Pacific
            const pacificStartTime = utcToPacificTime(startTime);
            const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

            // Verify this block is actually on the requested Pacific day
            const startUTC = new Date(startTime);
            const pacificStart = new Date(startUTC.getTime() + (PACIFIC_OFFSET * 60 * 60 * 1000));
            const pacificDateStr = pacificStart.toISOString().split('T')[0];
            
            if (pacificDateStr !== today) {
                console.log(`Block "${title}" is on ${pacificDateStr}, not ${today}, skipping`);
                return null;
            }

            const formattedBlock = {
                time: pacificStartTime,
                endTime: pacificEndTime,
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
        
        // Convert Pacific date range to proper timezone query
        const dayRange = getPacificDateRange(date);
        
        const events = await calendar.events.list({
            calendarId: workCalendarId,
            timeMin: dayRange.start,
            timeMax: dayRange.end,
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
            // The wake time in Notion is stored as Pacific time but treated as UTC
            // So if you entered 4:45 AM Pacific, it's stored as 4:45 AM UTC
            // We need to convert this to actual Pacific time
            wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        energy = log['Energy']?.number || 7;
        mood = log['Mood']?.select?.name || 'Good';
        focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        socialBattery = log['Social Battery']?.select?.name || 'Full';
    }

    console.log(`Creating intelligent schedule: Wake ${wakeTime} Pacific, Energy ${energy}, Focus ${focusCapacity}`);

    const tasks = await getTodaysTasks(today);
    const routineTasks = tasks.filter(t => t.routine || t.priority === 'Routine');
    console.log(`Found ${tasks.length} tasks total, ${routineTasks.length} routine tasks`);

    const workShift = await getWorkShift(today);
    console.log(`Work day: ${workShift.isWorkDay}`);

    await clearTodayBlocks(today);

    let schedule = [];
    
    if (workShift.isWorkDay) {
        schedule = createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity, tasks);
    } else {
        schedule = createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity);
    }

    let successCount = 0;
    let failedBlocks = [];
    let calendarEvents = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            
            // Convert Pacific times to UTC for storage in Notion
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: block.type } },
                    'Energy Requirements': { select: { name: block.energy } },
                    Status: { select: { name: 'Active' } },
                    'Start Time': { date: { start: startUTC } },
                    'End Time': { date: { start: endUTC } }
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

function createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity, allTasks) {
    console.log('Creating work day schedule with task integration and 30-minute increments');
    
    let schedule = [];
    let currentTime = wakeTime; // This is now properly in Pacific time
    
    // Separate tasks by type
    const meetings = allTasks.filter(t => t.type === 'meeting' && t.fixedTime);
    const priorityTasks = allTasks.filter(t => t.priority === 'High' && t.type !== 'meeting');
    const normalTasks = allTasks.filter(t => t.priority === 'Medium' && !t.routine && t.type !== 'meeting');
    const availableRoutineTasks = [...routineTasks];
    
    // Pre-work blocks in 30-minute increments
    schedule.push({
        title: 'Morning Routine (Work Camp)',
        start: currentTime,
        duration: 30,
        type: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // PRIORITY: Routine tasks before 10 AM (but also before work starts)
    const earliestWorkEnd = minutesToTime(Math.min(timeToMinutes('10:00'), timeToMinutes(workShift.startTime)));
    while (getMinutesBetween(currentTime, earliestWorkEnd) >= 30 && availableRoutineTasks.length > 0) {
        const task = availableRoutineTasks.shift();
        schedule.push({
            title: task.title,
            start: currentTime,
            duration: 30,
            type: 'Routine',
            energy: 'Medium',
            taskId: task.id
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    // Fill remaining pre-work time
    while (getMinutesBetween(currentTime, workShift.startTime) >= 30) {
        if (priorityTasks.length > 0) {
            const task = priorityTasks.shift();
            schedule.push({
                title: task.title,
                start: currentTime,
                duration: 30,
                type: task.type.charAt(0).toUpperCase() + task.type.slice(1),
                energy: 'Medium',
                taskId: task.id
            });
        } else {
            schedule.push({
                title: 'Work Prep & Planning',
                start: currentTime,
                duration: 30,
                type: 'Admin',
                energy: 'Medium'
            });
        }
        currentTime = addMinutes(currentTime, 30);
    }
    
    // WORK DAY BLOCKS with task integration - all times still in Pacific
    let workTime = workShift.startTime;
    const workEndTime = workShift.endTime;
    let taskIndex = 0;
    const workTasks = [...priorityTasks, ...normalTasks];
    
    while (getMinutesBetween(workTime, workEndTime) >= 30) {
        const currentHour = parseInt(workTime.split(':')[0]);
        
        // Check for fixed-time meetings first
        const meetingAtThisTime = meetings.find(m => {
            const meetingTime = utcToPacificTime(m.fixedTime);
            return meetingTime === workTime;
        });
        
        if (meetingAtThisTime) {
            const duration = meetingAtThisTime.estimatedTime || 30;
            schedule.push({
                title: meetingAtThisTime.title,
                start: workTime,
                duration: duration,
                type: 'Meeting',
                energy: 'Medium',
                taskId: meetingAtThisTime.id,
                fixedTime: true
            });
            workTime = addMinutes(workTime, duration);
            continue;
        }
        
        // Continue with remaining routine tasks before 10 AM
        if (currentHour < 10 && availableRoutineTasks.length > 0) {
            const task = availableRoutineTasks.shift();
            schedule.push({
                title: task.title,
                start: workTime,
                duration: 30,
                type: 'Routine',
                energy: 'Medium',
                taskId: task.id
            });
            workTime = addMinutes(workTime, 30);
            continue;
        }
        
        let blockType, blockTitle, blockEnergy;
        
        // Use actual tasks if available
        if (workTasks.length > 0 && taskIndex < workTasks.length) {
            const task = workTasks[taskIndex];
            blockTitle = task.title;
            blockType = task.type.charAt(0).toUpperCase() + task.type.slice(1);
            blockEnergy = task.priority === 'High' ? 'High' : 'Medium';
            schedule.push({
                title: blockTitle,
                start: workTime,
                duration: task.estimatedTime || 30,
                type: blockType,
                energy: blockEnergy,
                taskId: task.id
            });
            workTime = addMinutes(workTime, task.estimatedTime || 30);
            taskIndex++;
            continue;
        }
        
        // No tasks - create appropriate work blocks based on time and energy
        if (currentHour >= 5 && currentHour < 9) {
            if (energy >= 8 && focusCapacity === 'Sharp') {
                blockType = 'Deep Work';
                blockTitle = 'Deep Focus Work';
                blockEnergy = 'High';
            } else if (energy >= 6) {
                blockType = 'Creative';
                blockTitle = 'Creative/Project Work';
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Admin Tasks';
                blockEnergy = 'Medium';
            }
        } else if (currentHour >= 9 && currentHour < 12) {
            if (energy >= 7) {
                blockType = 'Deep Work';
                blockTitle = 'Deep Work Block';
                blockEnergy = 'High';
            } else {
                blockType = 'Creative';
                blockTitle = 'Project Work';
                blockEnergy = 'Medium';
            }
        } else if (currentHour === 12 && workTime === '12:00') {
            blockType = 'Break';
            blockTitle = 'Lunch Break';
            blockEnergy = 'Low';
        } else if (currentHour >= 13 && currentHour < 15) {
            if (energy >= 6) {
                blockType = 'Creative';
                blockTitle = 'Creative Work';
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Admin & Communications';
                blockEnergy = 'Medium';
            }
        } else {
            if (energy >= 5) {
                blockType = 'Admin';
                blockTitle = 'Admin & Wrap-up';
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Light Admin Tasks';
                blockEnergy = 'Low';
            }
        }
        
        schedule.push({
            title: blockTitle,
            start: workTime,
            duration: 30,
            type: blockType,
            energy: blockEnergy
        });
        
        workTime = addMinutes(workTime, 30);
    }
    
    // Post-work blocks - continuing from work end time
    let postWorkTime = workShift.endTime;
    const bedTime = '22:00'; // Pacific bedtime
    
    while (getMinutesBetween(postWorkTime, bedTime) >= 30) {
        const currentHour = parseInt(postWorkTime.split(':')[0]);
        
        let blockTitle, blockType, blockEnergy;
        
        if (currentHour >= 17 && currentHour < 19) {
            blockTitle = currentHour === 17 ? 'Post-Work Decompress' : 'Recovery Time';
            blockType = 'Break';
            blockEnergy = 'Low';
        } else if (currentHour >= 19 && currentHour < 21) {
            blockTitle = 'Personal Time & Recovery';
            blockType = 'Personal';
            blockEnergy = 'Low';
        } else {
            blockTitle = 'Wind Down & Sleep Prep';
            blockType = 'Personal';
            blockEnergy = 'Low';
        }
        
        schedule.push({
            title: blockTitle,
            start: postWorkTime,
            duration: 30,
            type: blockType,
            energy: blockEnergy
        });
        
        postWorkTime = addMinutes(postWorkTime, 30);
    }
    
    return schedule;
}

function createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity) {
    console.log('Creating home day schedule (with family time)');
    
    let schedule = [];
    let currentTime = wakeTime; // Now properly in Pacific time
    
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
        
        // Convert Pacific times to proper timezone for Google Calendar
        const startTime = pacificTimeToUTC(date, block.start);
        const endTime = pacificTimeToUTC(date, addMinutes(block.start, block.duration));
        
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
            const fixedTime = props['Fixed Time']?.date?.start;
            
            const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
            
            return {
                title,
                priority,
                due,
                type: type.toLowerCase(),
                routine,
                estimatedTime,
                autoSchedule,
                fixedTime,
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
        // Get UTC range that covers the Pacific day
        const pacificDayRange = getPacificDateRange(today);
        
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: pacificDayRange.start,
                    on_or_before: pacificDayRange.end
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

function timeToMinutes(timeStr) {
    const [hours, mins] = timeStr.split(':').map(Number);
    return hours * 60 + mins;
}

function minutesToTime(minutes) {
    const hours = Math.floor(minutes / 60) % 24;
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}
