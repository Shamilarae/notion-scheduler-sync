module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Get morning log for wake time
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
        
        // Calculate wake time from morning log
        let wakeTime = '4:30'; // fallback
        if (morningLogData.results && morningLogData.results.length > 0) {
            const wakeTimeRaw = morningLogData.results[0].properties?.['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                const wake = new Date(wakeTimeRaw);
                const pacificHours = wake.getUTCHours() - 7; // PDT adjustment
                const pacificMinutes = wake.getUTCMinutes();
                wakeTime = `${pacificHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
            }
        }
        
        // Get actual time blocks from database
        const timeBlocksResponse = await fetch(`https://api.notion.com/v1/databases/${TIME_BLOCKS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    property: 'Start Time',
                    date: { equals: today }
                },
                sorts: [{ property: 'Start Time', direction: 'ascending' }]
            })
        });
        
        const timeBlocksData = await timeBlocksResponse.json();
        
        // Work context detection (5:30 AM - 5:30 PM)
        const currentHour = new Date().getHours();
        const isWorkTime = currentHour >= 5 && currentHour <= 17;
        
        // Process time blocks with work context filtering
        const schedule = [];
        
        if (timeBlocksData.results && timeBlocksData.results.length > 0) {
            for (const block of timeBlocksData.results) {
                const startTime = block.properties?.['Start Time']?.date?.start;
                const endTime = block.properties?.['End Time']?.date?.start;
                const title = block.properties?.Title?.title?.[0]?.text?.content || 'Untitled Block';
                const blockType = block.properties?.['Block Type']?.select?.name || 'personal';
                const energy = block.properties?.['Energy Requirements']?.select?.name || 'medium';
                
                // Skip family/personal blocks during work hours
                if (isWorkTime) {
                    const lowerBlockType = blockType.toLowerCase();
                    if (lowerBlockType.includes('riley') || 
                        lowerBlockType.includes('family') || 
                        lowerBlockType === 'personal') {
                        continue; // Skip this block
                    }
                }
                
                if (startTime) {
                    const start = new Date(startTime);
                    const end = endTime ? new Date(endTime) : null;
                    
                    // Convert to Pacific Time
                    const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
                    const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;
                    
                    schedule.push({
                        time: `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}`,
                        endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                        title,
                        type: blockType.toLowerCase().replace(/\s+/g, '-'),
                        energy: energy.toLowerCase(),
                        details: `${energy} energy required`
                    });
                }
            }
        }
        
        // If no blocks found, create minimal morning routine
        if (schedule.length === 0) {
            const wakeHour = parseInt(wakeTime.split(':')[0]);
            const wakeMinute = parseInt(wakeTime.split(':')[1]);
            
            schedule.push({
                time: wakeTime,
                endTime: `${(wakeHour + 1).toString().padStart(2, '0')}:${wakeMinute.toString().padStart(2, '0')}`,
                title: 'Morning Routine',
                type: 'personal',
                energy: 'medium',
                details: 'Start your day'
            });
        }
        
        res.status(200).json({
            wakeTime,
            schedule,
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
            }),
            debug: {
                totalBlocks: timeBlocksData.results?.length || 0,
                isWorkTime,
                currentHour
            }
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to fetch timeline data',
            details: error.message 
        });
    }
};
