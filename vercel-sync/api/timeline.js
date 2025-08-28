// api/timeline.js - This will be your Vercel serverless function
import { Client } from '@notionhq/client';

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

export default async function handler(req, res) {
    try {
        // Get today's date
        const today = new Date().toISOString().split('T')[0];
        
        // Get today's morning log to find wake time
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

        let wakeTime = '3:45'; // Your actual wake time today
        if (morningLog.results.length > 0) {
            const wakeTimeRaw = morningLog.results[0].properties['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                // Convert UTC to Pacific Time (your timezone)
                const wake = new Date(wakeTimeRaw);
                const pacificTime = new Date(wake.getTime() - (8 * 60 * 60 * 1000)); // PST offset
                wakeTime = `${pacificTime.getUTCHours().toString().padStart(2, '0')}:${pacificTime.getUTCMinutes().toString().padStart(2, '0')}`;
            }
        }

        // Get today's time blocks
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

        // Transform the data for the timeline
        const schedule = timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled Block';
            const blockType = block.properties['Block Type']?.select?.name || 'personal';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            // Convert ISO to Pacific time format
            const start = startTime ? new Date(startTime) : null;
            const end = endTime ? new Date(endTime) : null;
            
            // Convert to Pacific Time
            const startPacific = start ? new Date(start.getTime() - (8 * 60 * 60 * 1000)) : null;
            const endPacific = end ? new Date(end.getTime() - (8 * 60 * 60 * 1000)) : null;

            return {
                time: startPacific ? `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy required`
            };
        }).filter(block => block.time); // Remove blocks without start time

        // If no blocks, create a basic structure starting from wake time
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
}