const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

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
            console.log('Creating simple intelligent schedule...');
            await createSimpleSchedule(today);
        }

        const schedule = await getCurrentSchedule(today);
        const morningData = await getMorningLogData(today);

        const now = new Date();
        const response = {
            schedule: schedule,
            morningData: morningData,
            lastUpdate: now.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: 'America/Los_Angeles'
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

async function createSimpleSchedule(today) {
    console.log('Getting morning log...');
    
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 1
    });

    if (morningLogResponse.results.length === 0) {
        throw new Error('No morning log found for today');
    }

    const morningData = extractMorningData(morningLogResponse.results[0]);
    console.log(`Energy: ${morningData.energy}, Focus: ${morningData.focusCapacity}`);

    // Clear existing blocks first - PROPERLY
    console.log('Clearing existing blocks...');
    await clearAllTodayBlocks(today);

    // Create complete schedule
    const completeSchedule = createCompleteSchedule(morningData);
    console.log(`Creating ${completeSchedule.length} blocks from ${completeSchedule[0].startTime} to ${completeSchedule[completeSchedule.length-1].endTime}`);

    // Save to Notion
    await saveBlocksToNotion(completeSchedule, today);
    
    console.log('Schedule created successfully');
}

function extractMorningData(log) {
    const props = log.properties;
    return {
        energy: parseInt(props.Energy?.select?.name || '5'),
        focusCapacity: props['Focus Capacity']?.select?.name || 'Normal',
        socialBattery: props['Social Battery']?.select?.name || 'Full',
        sleepQuality: props['Sleep Quality']?.number || 7,
        wakeTime: props['Wake Time']?.date?.start
    };
}

function createCompleteSchedule(morningData) {
    const schedule = [];
    const startTime = parseWakeTime(morningData.wakeTime);
    
    console.log(`Starting schedule at wake time: ${startTime}`);
    
    // Calculate intelligent bedtime first
    const bedtimeData = calculateOptimalBedtime(morningData);
    console.log(`Calculated optimal bedtime: ${bedtimeData.bedtime} (${bedtimeData.targetSleep}h sleep needed)`);
    
    // Create ALL blocks for the entire day
    const blocks = [
        // Morning
        { title: 'Morning Routine', start: startTime, duration: 60, type: 'Personal', energy: 'Low' },
        { title: 'Morning Planning', start: addMinutes(startTime, 60), duration: 30, type: 'Admin', energy: 'Medium' },
        
        // Work blocks based on energy
        ...createWorkBlocks(morningData, addMinutes(startTime, 90)),
        
        // Lunch
        { title: 'Lunch Break', start: '12:00', duration: 60, type: 'Break', energy: 'Low' },
        
        // Afternoon work - PROPERLY FILL UNTIL 5:30 PM
        { title: 'Afternoon Deep Work', start: '13:00', duration: 90, type: 'Deep Work', energy: 'Medium' },
        { title: 'Afternoon Admin', start: '14:30', duration: 90, type: 'Admin', energy: 'Medium' },
        { title: 'End-of-Day Work', start: '16:00', duration: 90, type: 'Admin', energy: 'Low' },
        
        // Evening blocks until calculated bedtime
        ...createEveningBlocks(bedtimeData)
    ];
    
    // Convert to proper format
    blocks.forEach(block => {
        const endTime = addMinutes(block.start, block.duration);
        schedule.push({
            title: block.title,
            startTime: block.start,
            endTime: endTime,
            blockType: block.type,
            energyReq: block.energy,
            duration: block.duration
        });
    });
    
    return schedule;
}

function calculateOptimalBedtime(morningData) {
    // Get tomorrow's wake time (assume same as today)
    const tomorrowWakeTime = morningData.wakeTime ? parseWakeTime(morningData.wakeTime) : '06:30';
    
    // Determine sleep needs based on today's energy patterns and sleep quality
    let targetSleepHours = 8; // Base recommendation
    
    // Adjust based on sleep quality from last night
    if (morningData.sleepQuality <= 4) {
        targetSleepHours = 9; // Need recovery sleep
    } else if (morningData.sleepQuality >= 8) {
        targetSleepHours = 7.5; // High efficiency sleep
    }
    
    // Adjust based on energy levels (if drained, need more recovery)
    if (morningData.energy <= 4) {
        targetSleepHours += 0.5; // Extra recovery time
    } else if (morningData.energy >= 8) {
        targetSleepHours -= 0.25; // Can get by with slightly less
    }
    
    // Calculate bedtime by working backwards from wake time
    const wakeMinutes = timeToMinutes(tomorrowWakeTime);
    const sleepDurationMinutes = targetSleepHours * 60;
    let bedtimeMinutes = wakeMinutes - sleepDurationMinutes;
    
    // Handle crossing midnight
    if (bedtimeMinutes < 0) {
        bedtimeMinutes += 24 * 60;
    }
    
    const bedtimeHours = Math.floor(bedtimeMinutes / 60);
    const bedtimeMins = bedtimeMinutes % 60;
    const bedtime = `${bedtimeHours.toString().padStart(2, '0')}:${bedtimeMins.toString().padStart(2, '0')}`;
    
    return {
        bedtime,
        targetSleep: targetSleepHours,
        wakeTime: tomorrowWakeTime,
        reasoning: `Based on sleep quality ${morningData.sleepQuality}/10 and energy ${morningData.energy}/10`
    };
}

function createEveningBlocks(bedtimeData) {
    const blocks = [];
    let currentTime = '17:30'; // End of work day
    
    // Work transition
    blocks.push({ 
        title: 'Work to Personal Transition', 
        start: currentTime, 
        duration: 15, 
        type: 'Break', 
        energy: 'Low' 
    });
    currentTime = addMinutes(currentTime, 15);
    
    // Dinner time
    blocks.push({ 
        title: 'Dinner', 
        start: currentTime, 
        duration: 60, 
        type: 'Personal', 
        energy: 'Low' 
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Calculate how much time until bedtime routine (1 hour before bed)
    const bedtimeRoutineStart = addMinutes(bedtimeData.bedtime, -60);
    const bedtimeRoutineMinutes = timeToMinutes(bedtimeRoutineStart);
    const currentMinutes = timeToMinutes(currentTime);
    const personalTimeMinutes = bedtimeRoutineMinutes - currentMinutes;
    
    console.log(`Personal time available: ${personalTimeMinutes} minutes (${currentTime} to ${bedtimeRoutineStart})`);
    
    // Fill personal time until bedtime routine
    if (personalTimeMinutes > 0) {
        let remainingPersonalTime = personalTimeMinutes;
        
        while (remainingPersonalTime > 0) {
            let blockDuration;
            let blockTitle;
            
            if (remainingPersonalTime >= 120) {
                blockDuration = 120;
                blockTitle = 'Personal Projects/Hobbies';
            } else if (remainingPersonalTime >= 90) {
                blockDuration = 90;
                blockTitle = 'Evening Personal Time';
            } else if (remainingPersonalTime >= 60) {
                blockDuration = 60;
                blockTitle = 'Relaxation Time';
            } else {
                blockDuration = remainingPersonalTime;
                blockTitle = 'Wind-down Time';
            }
            
            blocks.push({
                title: blockTitle,
                start: currentTime,
                duration: blockDuration,
                type: 'Personal',
                energy: 'Low'
            });
            
            currentTime = addMinutes(currentTime, blockDuration);
            remainingPersonalTime -= blockDuration;
        }
    }
    
    // Evening routine (1 hour before bed)
    blocks.push({
        title: 'Evening Routine & Tomorrow Prep',
        start: bedtimeRoutineStart,
        duration: 60,
        type: 'Personal',
        energy: 'Low'
    });
    
    // Sleep time with reasoning
    blocks.push({
        title: `Sleep (${bedtimeData.targetSleep}h target - ${bedtimeData.reasoning})`,
        start: bedtimeData.bedtime,
        duration: 30,
        type: 'Personal',
        energy: 'Low'
    });
    
    return blocks;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

function createWorkBlocks(morningData, startTime) {
    const energy = morningData.energy;
    const focus = morningData.focusCapacity;
    
    if (energy >= 7 && focus === 'Sharp') {
        return [
            { title: 'Deep Work Session', start: startTime, duration: 120, type: 'Deep Work', energy: 'High' },
            { title: 'Break', start: addMinutes(startTime, 120), duration: 15, type: 'Break', energy: 'Low' },
            { title: 'Creative Work', start: addMinutes(startTime, 135), duration: 90, type: 'Creative', energy: 'Medium' }
        ];
    } else if (energy >= 5) {
        return [
            { title: 'Focus Work', start: startTime, duration: 90, type: 'Deep Work', energy: 'High' },
            { title: 'Break', start: addMinutes(startTime, 90), duration: 15, type: 'Break', energy: 'Low' },
            { title: 'Admin Tasks', start: addMinutes(startTime, 105), duration: 75, type: 'Admin', energy: 'Medium' }
        ];
    } else {
        return [
            { title: 'Light Work', start: startTime, duration: 60, type: 'Admin', energy: 'Low' },
            { title: 'Rest Break', start: addMinutes(startTime, 60), duration: 30, type: 'Break', energy: 'Low' },
            { title: 'Easy Tasks', start: addMinutes(startTime, 90), duration: 90, type: 'Admin', energy: 'Low' }
        ];
    }
}

function parseWakeTime(wakeTimeStr) {
    if (!wakeTimeStr) return '06:30';
    
    const wake = new Date(wakeTimeStr);
    const pacificHours = wake.getUTCHours() - 7;
    const pacificMinutes = wake.getUTCMinutes();
    const adjustedHours = pacificHours < 0 ? pacificHours + 24 : pacificHours;
    
    return `${adjustedHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
}

function addMinutes(timeStr, minutes) {
    const [hours, mins] = timeStr.split(':').map(Number);
    const totalMins = hours * 60 + mins + minutes;
    const newHours = Math.floor(totalMins / 60) % 24;
    const newMins = totalMins % 60;
    return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

async function clearAllTodayBlocks(today) {
    try {
        // Get ALL blocks for today, including archived ones
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            }
        });

        console.log(`Found ${existing.results.length} existing blocks to remove`);

        // Actually delete them, don't just archive
        for (const block of existing.results) {
            try {
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
            } catch (deleteError) {
                console.warn(`Could not delete block ${block.id}:`, deleteError.message);
            }
        }
        
        console.log(`Cleared ${existing.results.length} blocks`);
    } catch (error) {
        console.error('Error clearing blocks:', error.message);
        throw error; // Don't continue if we can't clear - will create more duplicates
    }
}

async function saveBlocksToNotion(schedule, today) {
    console.log(`Saving ${schedule.length} blocks to Notion...`);
    
    for (const block of schedule) {
        try {
            const startDateTime = `${today}T${block.startTime}:00.000-07:00`;
            const endDateTime = `${today}T${block.endTime}:00.000-07:00`;

            await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: block.blockType } },
                    'Energy Requirements': { select: { name: block.energyReq } },
                    Status: { select: { name: 'Planned' } },
                    'Start Time': { date: { start: startDateTime } },
                    'End Time': { date: { start: endDateTime } }
                }
            });
            
            console.log(`Saved: ${block.title} (${block.startTime}-${block.endTime})`);
            
        } catch (error) {
            console.error(`Failed to save ${block.title}:`, error.message);
        }
    }
}

async function getCurrentSchedule(today) {
    try {
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }]
        });

        return timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled';
            const blockType = block.properties['Block Type']?.select?.name || 'personal';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            if (!startTime) return null;

            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
            const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

            return {
                time: `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}`,
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy • ${blockType}`
            };
        }).filter(block => block !== null);

    } catch (error) {
        console.error('Failed to get schedule:', error.message);
        return [];
    }
}

async function getMorningLogData(today) {
    try {
        const response = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: {
                property: 'Date',
                date: { equals: today }
            },
            page_size: 1
        });

        if (response.results.length === 0) return null;
        return extractMorningData(response.results[0]);
    } catch (error) {
        console.error('Failed to get morning log:', error.message);
        return null;
    }
}
