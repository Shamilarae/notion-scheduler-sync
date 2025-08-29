const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

// Define the database IDs as constants
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

module.exports = async function handler(req, res) {
    try {
        const timeBlocksTest = await notion.databases.retrieve(TIME_BLOCKS_DB_ID);
        const dailyLogsTest = await notion.databases.retrieve(DAILY_LOGS_DB_ID);
        
        const status = {
            timestamp: new Date().toISOString(),
            notion_connection: 'Connected ✅',
            time_blocks_db: timeBlocksTest?.title?.[0]?.plain_text || 'Time Blocks',
            daily_logs_db: dailyLogsTest?.title?.[0]?.plain_text || 'Daily Logs',
            node_version: process.version,
            database_ids: {
                time_blocks: TIME_BLOCKS_DB_ID,
                daily_logs: DAILY_LOGS_DB_ID
            },
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
