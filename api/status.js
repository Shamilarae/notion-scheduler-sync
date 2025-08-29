module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
        // Test direct fetch to Notion API instead of using the client library
        const response = await fetch(`https://api.notion.com/v1/databases/${TIME_BLOCKS_DB_ID}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            return res.status(500).json({
                error: `Notion API error: ${response.status} ${response.statusText}`,
                details: errorText,
                database_id_sent: TIME_BLOCKS_DB_ID,
                token_present: !!process.env.NOTION_TOKEN
            });
        }
        
        const data = await response.json();
        
        res.status(200).json({
            timestamp: new Date().toISOString(),
            notion_connection: 'Direct API Connected ✅',
            database_title: data.title?.[0]?.plain_text || 'Unknown',
            database_id_used: TIME_BLOCKS_DB_ID,
            token_present: !!process.env.NOTION_TOKEN
        });
        
    } catch (error) {
        res.status(500).json({
            timestamp: new Date().toISOString(),
            error: error.message,
            database_id_attempted: TIME_BLOCKS_DB_ID,
            token_present: !!process.env.NOTION_TOKEN
        });
    }
};
