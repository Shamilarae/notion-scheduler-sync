module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
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
                details: errorText
            });
        }
        
        const data = await response.json();
        
        res.status(200).json({
            timestamp: new Date().toISOString(),
            notion_connection: 'Connected ✅',
            database_title: data.title?.[0]?.plain_text || 'Unknown',
            node_version: process.version,
            token_present: !!process.env.NOTION_TOKEN
        });
        
    } catch (error) {
        res.status(500).json({
            timestamp: new Date().toISOString(),
            error: error.message,
            token_present: !!process.env.NOTION_TOKEN
        });
    }
};
