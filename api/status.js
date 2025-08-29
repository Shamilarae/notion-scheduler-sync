module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Get today's morning log
        const morningLogResponse = await fetch(`https://api.notion.com/v1/databases/${DAILY_LOGS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    property: 'Date',
                    date: { equals: today }
                },
                sorts: [{ timestamp: 'created_time', direction: 'descending' }],
                page_size: 1
            })
        });
        
        const morningLogData = await morningLogResponse.json();
        
        // Calculate wake time
        let wakeTime = '4:30';
        if (morningLogData.results?.length > 0) {
            const wakeTimeRaw = morningLogData.results[0].properties['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                const wake = new Date(wakeTimeRaw);
                const pacificHours = wake.getUTCHours() - 7;
                const pacificMinutes =
