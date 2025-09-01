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
    console.log('STARTING TEST SCHEDULE CREATION');
    
    // Don't try to clear - just create with unique titles to avoid confusion
    const timestamp = Date.now();
    const testBlocks = [
        { title: `Block 1:00-${timestamp}`, start: '13:00', end: '13:30' },
        { title: `Block 1:30-${timestamp}`, start: '13:30', end: '14:00' },
        { title: `Block 2:00-${timestamp}`, start: '14:00', end: '14:30' },
        { title: `Block 2:30-${timestamp}`, start: '14:30', end: '15:00' },
        { title: `Block 3:00-${timestamp}`, start: '15:00', end: '15:30' },
        { title: `Block 3:30-${timestamp}`, start: '15:30', end: '16:00' },
        { title: `Block 4:00-${timestamp}`, start: '16:00', end: '16:30' },
        { title: `Block 4:30-${timestamp}`, start: '16:30', end: '17:00' },
        { title: `Block 5:00-${timestamp}`, start: '17:00', end: '17:30' },
        { title: `Block 5:30-${timestamp}`, start: '17:30', end: '18:00' }
    ];
    
    console.log('ATTEMPTING TO CREATE ' + testBlocks.length + ' BLOCKS');
    
    let successCount = 0;
    let failCount = 0;
    let failedBlocks = [];
    
    for (const block of testBlocks) {
        try {
            // Create ISO datetime strings for Pacific Time (UTC-7 for PDT)
            const startDate = new Date(`${today}T${block.start}:00.000`);
            const endDate = new Date(`${today}T${block.end}:00.000`);
            
            // Convert to UTC by adding 7 hours (for PDT)
            const startUTC = new Date(startDate.getTime() + (7 * 60 * 60 * 1000));
            const endUTC = new Date(endDate.getTime() + (7 * 60 * 60 * 1000));
            
            const startDateTime = startUTC.toISOString();
            const endDateTime = endUTC.toISOString();
            
            await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: 'Admin' } },
                    'Energy Requirements': { select: { name: 'Medium' } },
                    Status: { select: { name: 'Planned' } },
                    'Start Time': { date: { start: startDateTime } },
                    'End Time': { date: { start: endDateTime } }
                }
            });
            
            successCount++;
            
        } catch (error) {
            failCount++;
            failedBlocks.push({
                title: block.title,
                error: error.message,
                time: block.start + '-' + block.end
            });
        }
    }
    
    // Store results for debugging
    global.lastCreationResult = {
        success: successCount,
        failed: failCount,
        failedBlocks: failedBlocks,
        timestamp: new Date().toISOString()
    };
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
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }]
        });

        console.log(`Retrieved ${timeBlocks.results.length} blocks from Notion`);

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
