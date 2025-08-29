const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

module.exports = async function handler(req, res) {
    try {
        const timeBlocksTest = await notion.databases.retrieve('2569f86b4f8e80439779e754eca8a066');
        const dailyLogsTest = await notion.databases.retrieve('2199f86b4f8e804e95f3c51884cff51a');
        
        const status = {
            timestamp: new Date().toISOString(),
            notion_connection: 'Connected ✅',
            time_blocks_db: timeBlocksTest?.title?.[0]?.plain_text || 'Time Blocks',
            daily_logs_db: dailyLogsTest?.title?.[0]?.plain_text || 'Daily Logs',
            node_version: process.version,
            environment: {
                has_notion_token: !!process.env.NOTION_TOKEN
            }
        };
        
        res.status(200).json(status);
    } catch (error) {
        res.status(500).json({
            timestamp: new Date().toISOString(),
            notion_connection: 'Failed ❌',
            error: error.message,
            environment: {
                has_notion_token: !!process.env.NOTION_TOKEN
            }
        });
    }
};
