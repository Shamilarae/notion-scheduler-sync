module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
        // Test both databases with direct API calls
        const [timeBlocksResponse, dailyLogsResponse] = await Promise.all([
            fetch(`https://api.notion.com/v1/databases/${TIME_BLOCKS_DB_ID}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                    'Notion-Version': '2022-06-28'
                }
            }),
            fetch(`https://api.notion.com/v1/databases/${DAILY_LOGS_DB_ID}`, {
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                    'Notion-Version': '2022-06-28'
                }
            })
        ]);
        
        const timeBlocksData = await timeBlocksResponse.json();
        const dailyLogsData = await dailyLogsResponse.json();
        
        res.status(200).json({
            timestamp: new Date().toISOString(),
            notion_connection: 'Connected ✅',
            time_blocks_db: timeBlocksData.title?.[0]?.plain_text || 'Time Blocks',
            daily_logs_db: dailyLogsData.title?.[0]?.plain_text || 'Daily Logs',
            node_version: process.version
        });
        
    } catch (error) {
        res.status(500).json({
            timestamp: new Date().toISOString(),
            notion_connection: 'Failed ❌',
            error: error.message
        });
    }
};
