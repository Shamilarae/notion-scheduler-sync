const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

module.exports = async function handler(req, res) {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        const morningLog = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: {
                property: 'Date',
                date: {
                    equals: today
                }
            },
            sorts: [
                {
                    timestamp: 'created_time',
                    direction: 'descending'
                }
            ],
            page_size: 1
        });

        let wakeTime = '4:30';
        if (morningLog.results.length > 0) {
            const wakeTimeRaw = morningLog.results[0].properties['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                const wake = new Date(wakeTimeRaw);
                const pacificHours = wake.getUTCHours() - 7;
                const pacificMinutes = wake.getUTCMinutes();
                wakeTime = `${pacificHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
            }
        }

        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    equals: today
                }
            },
            sorts: [
                {
                    property: 'Start Time',
                    direction: 'ascending'
                }
            ]
        });

        const currentHour = new Date().getHours();
        const isWorkTime = currentHour >= 5.5 && currentHour <= 17.5;

        const schedule = timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled Block';
            const blockType = block.properties['Block Type']?.select?.name || 'personal';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            if (isWorkTime) {
                if (['riley-time', 'riley time', 'family', 'personal'].includes(blockType.toLowerCase())) {
                    return null;
                }
            } else {
                if (blockType.toLowerCase() === 'routine work' && !title.toLowerCase().includes('urgent')) {
                    return null;
                }
            }

            const start = startTime ? new Date(startTime) : null;
            const end = endTime ? new Date(endTime) : null;
            
            const startPacific = start ? new Date(start.getTime() - (7 * 60 * 60 * 1000)) : null;
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

            return {
                time: startPacific ? `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy required`
            };
        }).filter(block => block !== null && block.time);

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

        const response = {
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
            })
        };

        res.status(200).json(response);
    } catch (error) {
        console.error('Timeline API Error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch timeline data',
            details: error.message 
        });
    }
};
