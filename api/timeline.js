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
            console.log('Creating SIMPLE test schedule...');
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
            const pacificHours = wake.getUTCHours() - 7;
            const pacificMinutes = wake.getUTCMinutes();
            const adjustedHours = pacificHours < 0 ? pacificHours + 24 : pacificHours;
            wakeTime = `${adjustedHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
        }
    }

    console.log(`Creating full day schedule starting at wake time: ${wakeTime}`);

    // Create full day schedule from wake time to 10 PM
    const fullDayBlocks = [
        { title: 'Morning Routine', start: wakeTime, duration: 60 },
        { title: 'Morning Planning', start: addMinutes(wakeTime, 60), duration: 30 },
        { title: 'Work Block 1', start: addMinutes(wakeTime, 90), duration: 90 },
        { title: 'Break', start: addMinutes(wakeTime, 180), duration: 15 },
        { title: 'Work Block 2', start: addMinutes(wakeTime, 195), duration: 90 },
        { title: 'Lunch', start: '12:00', duration: 60 },
        { title: 'Afternoon 1', start: '13:00', duration: 30 },
        { title: 'Afternoon 2', start: '13:30', duration: 30 },
        { title: 'Afternoon 3', start: '14:00', duration: 30 },
        { title: 'Afternoon 4', start: '14:30', duration: 30 },
        { title: 'Afternoon 5', start: '15:00', duration: 30 },
        { title: 'Afternoon 6', start: '15:30', duration: 30 },
        { title: 'Afternoon 7', start: '16:00', duration: 30 },
        { title: 'Afternoon 8', start: '16:30', duration: 30 },
        { title: 'End Work', start: '17:00', duration: 30 },
        { title: 'Transition', start: '17:30', duration: 30 },
        { title: 'Personal 1', start: '18:00', duration: 60 },
        { title: 'Personal 2', start: '19:00', duration: 60 },
        { title: 'Evening Routine', start: '20:00', duration: 60 },
        { title: 'Wind Down', start: '21:00', duration: 60 }
    ];

    // Clear old blocks by marking them with a "DELETE" status first
    try {
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            },
            page_size: 100
        });

        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                properties: {
                    Status: { select: { name: 'Planned' } }, // Change to help identify old blocks
                    Title: { title: [{ text: { content: 'OLD - ' + (block.properties.Title?.title[0]?.text?.content || 'Block') } }] }
                }
            });
        }
    } catch (error) {
        console.log('Error marking old blocks: ' + error.message);
    }

    let successCount = 0;
    let failedBlocks = [];
    
    for (const block of fullDayBlocks) {
        try {
            const startDate = new Date(`${today}T${block.start}:00.000`);
            const endTime = addMinutes(block.start, block.duration);
            const endDate = new Date(`${today}T${endTime}:00.000`);
            
            const startUTC = new Date(startDate.getTime() + (7 * 60 * 60 * 1000));
            const endUTC = new Date(endDate.getTime() + (7 * 60 * 60 * 1000));
            
            await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: 'Admin' } },
                    'Energy Requirements': { select: { name: 'Medium' } },
                    Status: { select: { name: 'Active' } }, // Use different status for new blocks
                    'Start Time': { date: { start: startUTC.toISOString() } },
                    'End Time': { date: { start: endUTC.toISOString() } }
                }
            });
            
            successCount++;
            
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
        wakeTime: wakeTime,
        timestamp: new Date().toISOString()
    };
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
        console.log('=== CLEARING EXISTING BLOCKS ===');
        
        // Get ALL blocks for today - including archived ones
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            },
            page_size: 100 // Get more results to catch all blocks
        });

        console.log(`Found ${existing.results.length} existing blocks for ${today}`);

        if (existing.results.length === 0) {
            console.log('No existing blocks to clear');
            return;
        }

        // List all blocks we're about to clear
        existing.results.forEach((block, index) => {
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled';
            const startTime = block.properties['Start Time']?.date?.start;
            console.log(`Block ${index + 1}: ${title} (${startTime}) - ID: ${block.id}`);
        });

        console.log('Archiving blocks...');
        let clearCount = 0;

        for (const block of existing.results) {
            try {
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
                clearCount++;
                console.log(`Archived block ${clearCount}/${existing.results.length}`);
            } catch (archiveError) {
                console.error(`Failed to archive block ${block.id}:`, archiveError.message);
            }
        }
        
        console.log(`Successfully cleared ${clearCount}/${existing.results.length} blocks`);
        
        // Wait a moment for Notion to process the archives
        console.log('Waiting 2 seconds for Notion to process archives...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
    } catch (error) {
        console.error('Error in clearAllTodayBlocks:', error.message);
        throw error; // Don't continue if clearing fails
    }
}

async function getCurrentSchedule(today) {
    try {
        // Get blocks with "Active" status first (new blocks), then others
        const activeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Start Time',
                        date: { equals: today }
                    },
                    {
                        property: 'Status',
                        select: { equals: 'Active' }
                    }
                ]
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 50
        });

        // If no active blocks, fall back to all blocks
        let timeBlocks = activeBlocks;
        if (activeBlocks.results.length === 0) {
            timeBlocks = await notion.databases.query({
                database_id: TIME_BLOCKS_DB_ID,
                filter: {
                    property: 'Start Time',
                    date: { equals: today }
                },
                sorts: [{ property: 'Start Time', direction: 'ascending' }],
                page_size: 50
            });
        }

        console.log(`Retrieved ${timeBlocks.results.length} blocks from Notion (Active: ${activeBlocks.results.length})`);

        return timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled';
            const blockType = block.properties['Block Type']?.select?.name || 'admin';
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
