module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Get all time blocks without date filter first
        const allBlocksResponse = await fetch(`https://api.notion.com/v1/databases/${TIME_BLOCKS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sorts: [{ property: 'Start Time', direction: 'ascending' }],
                page_size: 10
            })
        });
        
        const allBlocksData = await allBlocksResponse.json();
        
        // Debug: show what blocks exist
        const blockDates = allBlocksData.results?.map(block => ({
            title: block.properties?.Title?.title?.[0]?.text?.content,
            startTime: block.properties?.['Start Time']?.date?.start,
            blockType: block.properties?.['Block Type']?.select?.name
        })) || [];
        
        res.status(200).json({
            debug: {
                today,
                totalBlocks: allBlocksData.results?.length || 0,
                blockDates,
                queryFilter: `Looking for Start Time = ${today}`
            },
            wakeTime: '4:30',
            schedule: [{
                time: '04:30',
                endTime: '05:30', 
                title: 'Morning Routine (Debug Mode)',
                type: 'personal',
                energy: 'medium',
                details: 'Showing debug info above'
            }],
            lastUpdate: new Date().toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: 'America/Los_Angeles'
            }),
            date: new Date().toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            })
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Debug timeline error',
            details: error.message 
        });
    }
};
