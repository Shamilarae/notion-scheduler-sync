const { Client } = require('@notionhq/client');
const { google } = require('googleapis');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

// Your database IDs
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

// Google Calendar Config
const CALENDAR_CONFIG = {
    "Personal": "shamilarae@gmail.com",
    "Work_Admin": "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    "Work_Deep": "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    "Work_Meeting": "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    "Family": "family13053487624784455294@group.calendar.google.com"
};

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        console.log('🧠 Intelligent Timeline API triggered');
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';

        // If action is 'create', run the intelligent scheduler
        if (action === 'create') {
            console.log('🚀 Creating intelligent schedule...');
            await createIntelligentSchedule(today);
        }

        // Get the current schedule (either existing or newly created)
        const schedule = await getCurrentSchedule(today);
        const morningData = await getMorningLogData(today);

        // Context detection
        const currentHour = new Date().getHours();
        const isWorkTime = currentHour >= 5 && currentHour <= 18;

        const response = {
            schedule: schedule,
            morningData: morningData,
            context: {
                isWorkTime,
                currentHour,
                scheduleGenerated: schedule.length > 0
            },
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
        console.error('❌ Timeline API Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate timeline',
            details: error.message,
            fallbackSchedule: getFallbackSchedule()
        });
    }
};

async function createIntelligentSchedule(today) {
    console.log('📖 Analyzing morning log...');
    
    // Get morning log data
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 1
    });

    if (morningLogResponse.results.length === 0) {
        throw new Error('No morning log found. Complete your morning ritual first, princess.');
    }

    const log = morningLogResponse.results[0];
    const morningData = extractMorningData(log);
    
    console.log(`🧠 Analysis: Energy ${morningData.energy}/10, Focus: ${morningData.focusCapacity}`);

    // Generate intelligent schedule based on morning data
    const schedule = generateIntelligentSchedule(morningData);
    
    console.log(`📝 Creating ${schedule.length} time blocks...`);

    // Clear existing blocks for today first
    await clearExistingBlocks(today);

    // Create new blocks in Notion
    const createdBlocks = await createNotionBlocks(schedule, today);
    
    // Sync to Google Calendar if configured
    await syncToGoogleCalendar(createdBlocks, today);
    
    console.log('✅ Intelligent schedule created successfully');
    return createdBlocks;
}

function extractMorningData(log) {
    const props = log.properties;
    
    return {
        energy: parseInt(props.Energy?.select?.name || '5'),
        mood: props.Mood?.select?.name || 'Neutral',
        focusCapacity: props['Focus Capacity']?.select?.name || 'Normal',
        socialBattery: props['Social Battery']?.select?.name || 'Full',
        sleepQuality: props['Sleep Quality']?.number || 7,
        wakeTime: props['Wake Time']?.date?.start,
        sleepTime: props['Sleep Time']?.date?.start,
        intention: props.Intention?.rich_text?.[0]?.text?.content || ''
    };
}

function generateIntelligentSchedule(morningData) {
    const { energy, focusCapacity, socialBattery, sleepQuality } = morningData;
    
    // Sleep quality adjustment
    const sleepFactor = sleepQuality < 6 ? 0.7 : sleepQuality > 8 ? 1.2 : 1.0;
    const adjustedEnergy = Math.min(10, energy * sleepFactor);

    let schedule = [];
    let currentTime = parseWakeTime(morningData.wakeTime);

    // Morning routine (non-negotiable)
    schedule.push(createBlock('Morning Routine', currentTime, 60, 'Personal', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Morning planning
    schedule.push(createBlock('Morning Planning & Review', currentTime, 30, 'Admin', 'Medium'));
    currentTime = addMinutes(currentTime, 30);

    // Main work blocks based on energy and focus
    if (adjustedEnergy >= 8 && focusCapacity === 'Sharp') {
        // Peak performance mode
        schedule.push(createBlock('Deep Work - Core Project', currentTime, 150, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 150);
        
        schedule.push(createBlock('Active Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Creative Development', currentTime, 90, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
    } else if (adjustedEnergy >= 6 && focusCapacity !== 'Scattered') {
        // Standard productivity mode
        schedule.push(createBlock('Focused Work Block', currentTime, 90, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push(createBlock('Movement Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Admin & Communications', currentTime, 60, 'Admin', 'Medium'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Creative/Strategy Work', currentTime, 90, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
    } else {
        // Low energy/scattered focus mode
        schedule.push(createBlock('Light Admin Work', currentTime, 60, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Gentle Break', currentTime, 20, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 20);
        
        schedule.push(createBlock('Review & Planning', currentTime, 45, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 45);
    }

    // Lunch break
    schedule.push(createBlock('Lunch & Recharge', currentTime, 60, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Afternoon blocks
    if (socialBattery !== 'Drained') {
        schedule.push(createBlock('Collaboration/Meetings', currentTime, 90, 'Meeting Prep', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
    } else {
        schedule.push(createBlock('Solo Deep Work', currentTime, 90, 'Deep Work', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
    }

    // Riley time
    schedule.push(createBlock('Riley Time', currentTime, 90, 'Riley Time', 'Medium'));
    currentTime = addMinutes(currentTime, 90);

    // End of day
    schedule.push(createBlock('Day Review & Tomorrow Prep', currentTime, 30, 'Admin', 'Low'));

    return schedule;
}

function parseWakeTime(wakeTimeStr) {
    if (!wakeTimeStr) return '06:30';
    
    const wake = new Date(wakeTimeStr);
    // Convert UTC to Pacific Time - subtract 7 hours for PDT
    const pacificHours = wake.getUTCHours() - 7;
    const pacificMinutes = wake.getUTCMinutes();
    return `${pacificHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
}

function addMinutes(timeStr, minutes) {
    const [hours, mins] = timeStr.split(':').map(Number);
    const totalMins = hours * 60 + mins + minutes;
    const newHours = Math.floor(totalMins / 60) % 24;
    const newMins = totalMins % 60;
    return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

function createBlock(title, startTime, durationMins, blockType, energyReq) {
    const endTime = addMinutes(startTime, durationMins);
    return {
        title,
        startTime,
        endTime,
        blockType,
        energyReq,
        duration: durationMins
    };
}

async function clearExistingBlocks(today) {
    try {
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            }
        });

        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        console.log(`🗑️ Cleared ${existing.results.length} existing blocks`);
    } catch (error) {
        console.warn('⚠️ Could not clear existing blocks:', error.message);
    }
}

async function createNotionBlocks(schedule, today) {
    const createdBlocks = [];

    for (const block of schedule) {
        try {
            const startDateTime = `${today}T${block.startTime}:00.000-07:00`; // PDT timezone
            const endDateTime = `${today}T${block.endTime}:00.000-07:00`;

            const response = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    'Block Type': { select: { name: block.blockType } },
                    'Energy Requirements': { select: { name: block.energyReq } },
                    Status: { select: { name: 'Planned' } },
                    'Start Time': { date: { start: startDateTime } },
                    'End Time': { date: { start: endDateTime } }
                }
            });

            createdBlocks.push({ notionId: response.id, ...block });
        } catch (error) {
            console.error(`❌ Failed to create block: ${block.title}`, error.message);
        }
    }

    return createdBlocks;
}

async function syncToGoogleCalendar(blocks, today) {
    // Skip Google Calendar sync in Vercel for now - requires service account setup
    console.log('📅 Google Calendar sync skipped (configure service account for full sync)');
    return;
}

async function getCurrentSchedule(today) {
    try {
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: { equals: today }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }]
        });

        return timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled Block';
            const blockType = block.properties['Block Type']?.select?.name || 'personal';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            // Convert UTC to Pacific Time
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
                details: `${energy} energy • ${blockType}`
            };
        }).filter(block => block.time);

    } catch (error) {
        console.error('❌ Failed to get current schedule:', error.message);
        return getFallbackSchedule();
    }
}

async function getMorningLogData(today) {
    try {
        const response = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: {
                property: 'Date',
                date: { equals: today }
            },
            page_size: 1
        });

        if (response.results.length === 0) return null;

        return extractMorningData(response.results[0]);
    } catch (error) {
        console.error('❌ Failed to get morning log:', error.message);
        return null;
    }
}

function getFallbackSchedule() {
    const currentTime = new Date();
    const baseHour = Math.max(6, currentTime.getHours());
    
    return [
        {
            time: `${baseHour.toString().padStart(2, '0')}:00`,
            endTime: `${(baseHour + 1).toString().padStart(2, '0')}:00`,
            title: 'Morning Routine',
            type: 'personal',
            energy: 'medium',
            details: 'Start your day'
        },
        {
            time: `${(baseHour + 1).toString().padStart(2, '0')}:00`,
            endTime: `${(baseHour + 3).toString().padStart(2, '0')}:00`,
            title: 'Focus Work Block',
            type: 'deep-work',
            energy: 'high',
            details: 'Core productive time'
        },
        {
            time: `${(baseHour + 3).toString().padStart(2, '0')}:00`,
            endTime: `${(baseHour + 4).toString().padStart(2, '0')}:00`,
            title: 'Admin & Planning',
            type: 'admin',
            energy: 'medium',
            details: 'Organization time'
        }
    ];
}
