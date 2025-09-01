const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar integration using service account
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
});

const calendar = google.calendar({ version: 'v3', auth });

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
            console.log('Creating intelligent schedule with Google Calendar integration...');
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
        
        // Get blocks that start today OR tomorrow (to catch evening blocks that cross midnight)
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

        console.log(`Found ${timeBlocks.results.length} blocks in Notion for ${today} (extended range)`);

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

            // Convert UTC to Pacific Time (PDT = UTC-7, PST = UTC-8)
            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
            // Convert to Pacific timezone - need to ADD 7 hours to get from UTC to PDT
            const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

            // Filter out blocks that don't belong to "today" in Pacific time
            const pacificMidnight = new Date(`${today}T00:00:00-07:00`);
            const nextDayMidnight = new Date(`${today}T23:59:59-07:00`);
            
            if (startPacific < pacificMidnight || startPacific > nextDayMidnight) {
                return null; // Skip blocks outside of today
            }

            const formattedBlock = {
                time: `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}`,
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy • ${blockType}`
            };

            console.log(`Block: ${title} - ${formattedBlock.time} to ${formattedBlock.endTime}`);
            return formattedBlock;
        }).filter(block => block !== null);

        console.log(`Returning ${schedule.length} formatted blocks for today`);
        return schedule;

    } catch (error) {
        console.error('Failed to get schedule:', error.message);
        console.error('Full error:', error);
        return [];
    }
}

async function getWorkShift(date) {
    try {
        // Check Shamila Work Shift calendar
        const workCalendarId = 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com';
        
        const events = await calendar.events.list({
            calendarId: workCalendarId,
            timeMin: `${date}T00:00:00-07:00`,
            timeMax: `${date}T23:59:59-07:00`,
            singleEvents: true,
            orderBy: 'startTime'
        });

        if (events.data.items && events.data.items.length > 0) {
            // You have a work event today
            const workEvent = events.data.items[0];
            
            // For multi-day rotational work, assume standard 12-hour day shift
            return {
                isWorkDay: true,
                startTime: '05:30', // Your actual shift start
                endTime: '17:30',   // Your actual shift end
                title: 'Work Shift'
            };
        }
        
        return { isWorkDay: false };
    } catch (error) {
        console.error('Error checking work schedule:', error.message);
        return { isWorkDay: false }; // Default to no work if can't check
    }
}

async function createIntelligentSchedule(today) {
    // Get morning log data
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        page_size: 1
    });

    let wakeTime = '06:30'; // default
    let energy = 7; // default medium
    let mood = 'Good'; // default
    
    if (morningLogResponse.results.length > 0) {
        const log = morningLogResponse.results[0].properties;
        
        // Get wake time
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            const wake = new Date(wakeTimeRaw);
            const pacificTime = new Date(wake.getTime() - (7 * 60 * 60 * 1000));
            wakeTime = `${pacificTime.getUTCHours().toString().padStart(2, '0')}:${pacificTime.getUTCMinutes().toString().padStart(2, '0')}`;
        }
        
        // Get energy and mood for intelligent scheduling
        energy = log['Energy']?.number || 7;
        mood = log['Mood']?.select?.name || 'Good';
    }

    console.log(`Creating schedule: Wake ${wakeTime}, Energy ${energy}, Mood ${mood}`);

    // Check work schedule
    const workShift = await getWorkShift(today);
    console.log('Work shift:', workShift);

    // Clear existing blocks first
    await clearTodayBlocks(today);

    let schedule = [];
    
    if (workShift.isWorkDay) {
        // WORK DAY SCHEDULE - Mining rotation: minimal morning, full evening
        schedule = [
            { title: 'Wake & Go', start: wakeTime, duration: 50, type: 'Personal', energy: 'Medium' },
            { title: workShift.title, start: workShift.startTime, duration: getMinutesBetween(workShift.startTime, workShift.endTime), type: 'Deep Work', energy: 'High' },
            { title: 'Decompress', start: addMinutes(workShift.endTime, 0), duration: 30, type: 'Break', energy: 'Low' },
            { title: 'Riley Time', start: addMinutes(workShift.endTime, 30), duration: 120, type: 'Riley Time', energy: 'Medium' },
            { title: 'Dinner & Family', start: addMinutes(workShift.endTime, 150), duration: 90, type: 'Personal', energy: 'Low' },
            { title: 'Personal Time', start: addMinutes(workShift.endTime, 240), duration: 60, type: 'Personal', energy: 'Low' },
            { title: 'Wind Down', start: addMinutes(workShift.endTime, 300), duration: 60, type: 'Personal', energy: 'Low' }
        ];
    } else {
        // OFF DAY SCHEDULE - Full day with Riley time, family time, deep work
        const morningBlocks = [
            { title: 'Morning Routine', start: wakeTime, duration: 60, type: 'Personal', energy: 'Medium' },
            { title: 'Morning Planning', start: addMinutes(wakeTime, 60), duration: 30, type: 'Admin', energy: energy >= 8 ? 'High' : 'Medium' }
        ];
        
        // Add deep work blocks based on energy
        if (energy >= 8) {
            morningBlocks.push({ title: 'Deep Work Block 1', start: addMinutes(wakeTime, 90), duration: 120, type: 'Deep Work', energy: 'High' });
            morningBlocks.push({ title: 'Break', start: addMinutes(wakeTime, 210), duration: 15, type: 'Break', energy: 'Low' });
            morningBlocks.push({ title: 'Deep Work Block 2', start: addMinutes(wakeTime, 225), duration: 90, type: 'Deep Work', energy: 'High' });
        } else {
            morningBlocks.push({ title: 'Creative Work', start: addMinutes(wakeTime, 90), duration: 90, type: 'Creative', energy: 'Medium' });
            morningBlocks.push({ title: 'Admin Tasks', start: addMinutes(wakeTime, 180), duration: 60, type: 'Admin', energy: 'Medium' });
        }
        
        schedule = [
            ...morningBlocks,
            { title: 'Lunch Break', start: '12:00', duration: 60, type: 'Break', energy: 'Low' },
            { title: 'Riley Time', start: '13:00', duration: 120, type: 'Riley Time', energy: 'Medium' },
            { title: 'Personal Projects', start: '15:00', duration: 90, type: 'Creative', energy: 'Medium' },
            { title: 'Family Time', start: '16:30', duration: 60, type: 'Personal', energy: 'Low' },
            { title: 'Admin/Planning', start: '17:30', duration: 30, type: 'Admin', energy: 'Low' },
            { title: 'Dinner & Family', start: '18:00', duration: 90, type: 'Personal', energy: 'Low' },
            { title: 'Evening Activities', start: '19:30', duration: 90, type: 'Personal', energy: 'Low' },
            { title: 'Wind Down', start: '21:00', duration: 60, type: 'Personal', energy: 'Low' }
        ];
    }

    let successCount = 0;
    let failedBlocks = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            
            // Convert Pacific time to UTC for storage
            const startUTC = new Date(`${today}T${block.start}:00.000-07:00`);
            const endUTC = new Date(`${today}T${endTime}:00.000-07:00`);
            
            await notion.pages.create({
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
            console.log(`Created: ${block.title} (${block.start} - ${endTime})`);
            
        } catch (error) {
            console.error(`Failed to create ${block.title}:`, error.message);
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
        wakeTime: wakeTime,
        workDay: workShift.isWorkDay,
        workShift: workShift.isWorkDay ? `${workShift.startTime}-${workShift.endTime}` : 'Off Day',
        timestamp: new Date().toISOString()
    };
    
    console.log(`Intelligent schedule creation complete: ${successCount} success, ${failedBlocks.length} failed`);
    console.log(`Work status: ${workShift.isWorkDay ? 'WORK DAY' : 'OFF DAY'}`);
}

async function clearTodayBlocks(today) {
    try {
        console.log('Clearing existing blocks...');
        
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

        console.log(`Found ${existing.results.length} existing blocks to clear`);

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
        
        console.log(`Cleared ${existing.results.length} blocks`);
        
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

async function getTodaysTasks(today) {
    try {
        // Get tasks scheduled for today or overdue
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                or: [
                    {
                        property: 'Due',
                        date: { on_or_before: today }
                    },
                    {
                        property: 'Schedule Today?',
                        checkbox: { equals: true }
                    }
                ]
            },
            sorts: [
                { property: 'Priority', direction: 'ascending' }, // Higher priority first
                { property: 'Due', direction: 'ascending' } // Earlier due dates first
            ],
            page_size: 50
        });

        return tasksResponse.results.map(task => {
            const title = task.properties.Name?.title[0]?.text?.content || 'Untitled Task';
            const priority = task.properties.Priority?.select?.name || 'Medium';
            const due = task.properties.Due?.date?.start;
            const project = task.properties.Project?.select?.name;
            const routine = task.properties.Routine?.checkbox || false;
            const estimatedTime = task.properties['Estimated Time']?.number || 30; // default 30 min
            
            return {
                title,
                priority,
                due,
                project,
                routine,
                estimatedTime,
                id: task.id
            };
        });
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        return [];
    }
}

function createIntelligentWorkBlocks(workShift, energy, focusCapacity, socialBattery, tasks) {
    const workBlocks = [];
    let currentTime = workShift.startTime;
    const endTime = workShift.endTime;
    
    // Separate routine vs project tasks
    const routineTasks = tasks.filter(t => t.routine);
    const projectTasks = tasks.filter(t => !t.routine);
    
    console.log(`Creating work blocks: ${routineTasks.length} routine, ${projectTasks.length} project tasks`);
    
    // FIRST HOUR: Routine tasks (due in morning)
    if (routineTasks.length > 0) {
        for (const task of routineTasks.slice(0, 2)) { // Max 2 routine tasks
            workBlocks.push({
                title: task.title,
                start: currentTime,
                duration: 30,
                type: 'Admin',
                energy: 'Medium'
            });
            currentTime = addMinutes(currentTime, 30);
        }
    } else {
        // No routine tasks - start with general admin
        workBlocks.push({
            title: 'Morning Admin',
            start: currentTime,
            duration: 30,
            type: 'Admin',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    // Create blocks for the rest of the shift based on energy patterns
    while (getMinutesBetween(currentTime, endTime) >= 30) {
        const remainingMinutes = getMinutesBetween(currentTime, endTime);
        const currentHour = parseInt(currentTime.split(':')[0]);
        
        // Energy pattern: High morning (6-10), medium mid-day (10-14), low afternoon (14-17)
        let blockEnergy, blockType, duration;
        
        if (currentHour < 10) {
            // Morning: High energy period
            if (energy >= 8 && focusCapacity === 'Sharp') {
                blockType = 'Deep Work';
                blockEnergy = 'High';
                duration = 90; // 1.5 hour deep focus blocks
            } else {
                blockType = 'Admin';
                blockEnergy = 'Medium';
                duration = 60;
            }
        } else if (currentHour < 14) {
            // Mid-day: Steady work
            if (energy >= 6) {
                blockType = projectTasks.length > 0 ? 'Creative' : 'Admin';
                blockEnergy = 'Medium';
                duration = 60;
            } else {
                blockType = 'Admin';
                blockEnergy = 'Medium';
                duration = 30;
            }
        } else {
            // Afternoon: Lower energy, more admin
            blockType = 'Admin';
            blockEnergy = 'Low';
            duration = 30;
        }
        
        // Add lunch break
        if (currentTime === '12:00') {
            workBlocks.push({
                title: 'Lunch Break',
                start: currentTime,
                duration: 30,
                type: 'Break',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 30);
            continue;
        }
        
        // Add breaks every 2-3 hours based on energy
        const hoursSinceStart = getMinutesBetween(workShift.startTime, currentTime) / 60;
        if (hoursSinceStart > 0 && hoursSinceStart % (energy >= 7 ? 3 : 2) === 0) {
            workBlocks.push({
                title: 'Break',
                start: currentTime,
                duration: 15,
                type: 'Break',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            continue;
        }
        
        // Adjust duration if near end of shift
        if (remainingMinutes < duration) {
            duration = remainingMinutes;
        }
        
        // Get next task or create generic block
        let blockTitle;
        if (projectTasks.length > 0 && (blockType === 'Deep Work' || blockType === 'Creative')) {
            const nextTask = projectTasks.shift();
            blockTitle = nextTask.title;
        } else {
            blockTitle = blockType === 'Deep Work' ? 'Deep Focus Work' : 
                       blockType === 'Creative' ? 'Project Work' :
                       blockType === 'Admin' ? 'Admin Tasks' : 'Work Block';
        }
        
        workBlocks.push({
            title: blockTitle,
            start: currentTime,
            duration: duration,
            type: blockType,
            energy: blockEnergy
        });
        
        currentTime = addMinutes(currentTime, duration);
    }
    
    console.log(`Created ${workBlocks.length} work blocks from ${workShift.startTime} to ${workShift.endTime}`);
    return workBlocks;
}

function getMinutesBetween(startTime, endTime) {
    const [startHours, startMins] = startTime.split(':').map(Number);
    const [endHours, endMins] = endTime.split(':').map(Number);
    const startTotalMins = startHours * 60 + startMins;
    const endTotalMins = endHours * 60 + endMins;
    return endTotalMins - startTotalMins;
}
