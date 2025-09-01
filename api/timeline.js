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
            console.log('Creating schedule...');
            await createTestSchedule(today);
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

async function getCurrentSchedule(today) {
    try {
        console.log(`Getting schedule for ${today}...`);
        
        // Query all blocks for today - no status filter first
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: `${today}T00:00:00.000Z`,
                    on_or_before: `${today}T23:59:59.999Z`
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

            // Convert UTC to Pacific Time (PDT = UTC-7, PST = UTC-8)
            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
            // Convert to Pacific timezone
            const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

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

        console.log(`Returning ${schedule.length} formatted blocks`);
        return schedule;

    } catch (error) {
        console.error('Failed to get schedule:', error.message);
        console.error('Full error:', error);
        return [];
    }
}

async function createTestSchedule(today) {
    // Get wake time from morning log
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        page_size: 1
    });

    let wakeTime = '06:30'; // default
    if (morningLogResponse.results.length > 0) {
        const wakeTimeRaw = morningLogResponse.results[0].properties['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            const wake = new Date(wakeTimeRaw);
            // Convert UTC to Pacific
            const pacificTime = new Date(wake.getTime() - (7 * 60 * 60 * 1000));
            wakeTime = `${pacificTime.getUTCHours().toString().padStart(2, '0')}:${pacificTime.getUTCMinutes().toString().padStart(2, '0')}`;
        }
    }

    console.log(`Creating schedule starting at wake time: ${wakeTime}`);

    // Create comprehensive schedule from wake time to 10 PM
    const fullDayBlocks = [
        { title: 'Morning Routine', start: wakeTime, duration: 60, type: 'Personal', energy: 'Medium' },
        { title: 'Morning Planning', start: addMinutes(wakeTime, 60), duration: 30, type: 'Admin', energy: 'High' },
        { title: 'Deep Work Block 1', start: addMinutes(wakeTime, 90), duration: 90, type: 'Deep Work', energy: 'High' },
        { title: 'Break', start: addMinutes(wakeTime, 180), duration: 15, type: 'Break', energy: 'Low' },
        { title: 'Deep Work Block 2', start: addMinutes(wakeTime, 195), duration: 90, type: 'Deep Work', energy: 'High' },
        { title: 'Lunch Break', start: '12:00', duration: 60, type: 'Break', energy: 'Low' },
        { title: 'Creative Work 1', start: '13:00', duration: 60, type: 'Creative', energy: 'Medium' },
        { title: 'Admin Tasks', start: '14:00', duration: 60, type: 'Admin', energy: 'Medium' },
        { title: 'Riley Time', start: '15:00', duration: 90, type: 'Riley Time', energy: 'Medium' },
        { title: 'Personal Projects', start: '16:30', duration: 60, type: 'Creative', energy: 'Medium' },
        { title: 'Wrap Up Work', start: '17:30', duration: 30, type: 'Admin', energy: 'Low' },
        { title: 'Personal Time 1', start: '18:00', duration: 60, type: 'Personal', energy: 'Low' },
        { title: 'Dinner & Family', start: '19:00', duration: 60, type: 'Personal', energy: 'Low' },
        { title: 'Evening Activities', start: '20:00', duration: 60, type: 'Personal', energy: 'Low' },
        { title: 'Wind Down', start: '21:00', duration: 60, type: 'Personal', energy: 'Low' }
    ];

    // Clear existing blocks first
    await clearTodayBlocks(today);

    let successCount = 0;
    let failedBlocks = [];
    
    for (const block of fullDayBlocks) {
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
        timestamp: new Date().toISOString()
    };
    
    console.log(`Schedule creation complete: ${successCount} success, ${failedBlocks.length} failed`);
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
