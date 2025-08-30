const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

// Your actual database IDs
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        console.log('🧠 Intelligent Timeline API triggered at:', new Date().toISOString());
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';

        // If action is 'create', run the intelligent scheduler
        if (action === 'create') {
            console.log('🚀 Creating intelligent schedule based on morning log...');
            await createIntelligentSchedule(today);
        }

        // Get the current schedule and morning data
        const schedule = await getCurrentSchedule(today);
        const morningData = await getMorningLogData(today);

        // Context detection
        const now = new Date();
        const currentHour = now.getHours();
        const isWorkTime = currentHour >= 5 && currentHour <= 18;

        const response = {
            schedule: schedule,
            morningData: morningData,
            context: {
                isWorkTime,
                currentHour,
                scheduleGenerated: schedule.length > 0,
                hasIntelligentBlocks: schedule.some(s => s.title.includes('Deep Work') || s.title.includes('Creative'))
            },
            wakeTime: morningData?.wakeTime ? parseWakeTime(morningData.wakeTime) : '06:30',
            lastUpdate: now.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: 'America/Los_Angeles'
            }),
            date: now.toLocaleDateString('en-US', { 
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
            schedule: getFallbackSchedule()
        });
    }
};

// ──────────────────────────────────────────────────
// 🧠 INTELLIGENT SCHEDULING LOGIC
// ──────────────────────────────────────────────────

async function createIntelligentSchedule(today) {
    console.log('📖 Analyzing morning log data...');
    
    // Get today's morning log
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
        throw new Error('No morning log found for today. Complete your morning ritual first, princess.');
    }

    const log = morningLogResponse.results[0];
    const morningData = extractMorningData(log);
    
    console.log(`🧠 Analysis Complete:`);
    console.log(`   Energy: ${morningData.energy}/10`);
    console.log(`   Focus: ${morningData.focusCapacity}`);
    console.log(`   Social Battery: ${morningData.socialBattery}`);
    console.log(`   Sleep Quality: ${morningData.sleepQuality}/10`);

    // Generate intelligent schedule
    const schedule = generateIntelligentSchedule(morningData);
    console.log(`📝 Generated ${schedule.length} intelligent time blocks`);

    // Clear existing blocks for today
    await clearExistingBlocks(today);

    // Create new blocks in Notion
    const createdBlocks = await createNotionBlocks(schedule, today);
    console.log(`✅ Created ${createdBlocks.length} time blocks in Notion`);
    
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
    
    // Adjust energy based on sleep quality
    const sleepFactor = sleepQuality < 6 ? 0.7 : sleepQuality > 8 ? 1.2 : 1.0;
    const adjustedEnergy = Math.min(10, energy * sleepFactor);

    console.log(`🎯 Adjusted energy: ${adjustedEnergy.toFixed(1)}/10 (sleep factor: ${sleepFactor})`);

    let schedule = [];
    let currentTime = parseWakeTime(morningData.wakeTime);

    // Morning routine (non-negotiable)
    schedule.push(createBlock('Morning Routine', currentTime, 60, 'Personal', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Morning planning and log review
    schedule.push(createBlock('Morning Planning & Log Review', currentTime, 30, 'Admin', 'Medium'));
    currentTime = addMinutes(currentTime, 30);

    // INTELLIGENT WORK BLOCKS based on energy and focus
    if (adjustedEnergy >= 8 && focusCapacity === 'Sharp') {
        // PEAK PERFORMANCE MODE
        console.log('🔥 Peak performance mode activated');
        schedule.push(createBlock('Deep Work - Core Project Focus', currentTime, 150, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 150);
        
        schedule.push(createBlock('Active Movement Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Creative Development Work', currentTime, 90, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
    } else if (adjustedEnergy >= 6 && focusCapacity !== 'Scattered') {
        // STANDARD PRODUCTIVITY MODE
        console.log('⚡ Standard productivity mode');
        schedule.push(createBlock('Focused Work Block', currentTime, 90, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push(createBlock('Movement & Refresh Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Admin & Communications', currentTime, 60, 'Admin', 'Medium'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Creative Strategy Work', currentTime, 75, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 75);
        
    } else {
        // LOW ENERGY / RECOVERY MODE
        console.log('🛡️ Recovery mode - gentle schedule');
        schedule.push(createBlock('Light Admin & Organization', currentTime, 60, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Gentle Rest Break', currentTime, 20, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 20);
        
        schedule.push(createBlock('Review & Light Planning', currentTime, 45, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 45);
        
        schedule.push(createBlock('Easy Creative Tasks', currentTime, 60, 'Creative', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    }

    // Lunch break - always important
    schedule.push(createBlock('Lunch & Recharge Time', currentTime, 60, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Afternoon blocks - adjusted for social battery
    if (socialBattery === 'Drained') {
        console.log('🔋 Social battery drained - solo work mode');
        schedule.push(createBlock('Solo Deep Work Session', currentTime, 90, 'Deep Work', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
    } else if (socialBattery === 'Half-Drained') {
        console.log('⚡ Half social battery - light collaboration');
        schedule.push(createBlock('Light Collaboration Work', currentTime, 60, 'Meeting Prep', 'Medium'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Solo Wrap-up Tasks', currentTime, 30, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 30);
    } else {
        console.log('🤝 Full social battery - meetings welcome');
        schedule.push(createBlock('Meetings & Collaboration', currentTime, 90, 'Meeting Prep', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
    }

    // Continue afternoon work until 5:30PM
    const endOfWorkDay = '17:30'; // 5:30 PM
    while (timeToMinutes(currentTime) < timeToMinutes(endOfWorkDay)) {
        const remainingWorkTime = timeToMinutes(endOfWorkDay) - timeToMinutes(currentTime);
        
        if (remainingWorkTime >= 90) {
            // Long work block
            if (adjustedEnergy >= 6) {
                schedule.push(createBlock('Afternoon Focus Block', currentTime, 90, 'Deep Work', 'Medium'));
            } else {
                schedule.push(createBlock('Afternoon Admin Work', currentTime, 90, 'Admin', 'Low'));
            }
            currentTime = addMinutes(currentTime, 90);
        } else if (remainingWorkTime >= 45) {
            // Medium work block
            schedule.push(createBlock('End-of-Day Tasks', currentTime, remainingWorkTime, 'Admin', 'Low'));
            currentTime = addMinutes(currentTime, remainingWorkTime);
        } else if (remainingWorkTime > 0) {
            // Short wrap-up
            schedule.push(createBlock('Day Wrap-up', currentTime, remainingWorkTime, 'Admin', 'Low'));
            currentTime = addMinutes(currentTime, remainingWorkTime);
        }
    }

    // EVENING SCHEDULE - After 5:30PM
    currentTime = '17:30'; // Ensure we start evening at 5:30

    // Transition time
    schedule.push(createBlock('Work to Home Transition', currentTime, 15, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 15);

    // Family time - sacred time
    schedule.push(createBlock('Riley Time - Family Priority', currentTime, 90, 'Riley Time', 'Medium'));
    currentTime = addMinutes(currentTime, 90);

    // Dinner time
    schedule.push(createBlock('Dinner & Family Time', currentTime, 60, 'Personal', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Evening personal time
    schedule.push(createBlock('Personal/Hobby Time', currentTime, 60, 'Personal', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // Calculate bedtime based on tomorrow's wake time and sleep needs
    const bedtimeData = calculateOptimalBedtime(morningData);
    
    // Evening routine leading to bedtime
    const eveningRoutineStart = addMinutes(bedtimeData.bedtime, -60); // 1 hour before bed
    
    // Fill time between current time and evening routine
    const timeGap = timeToMinutes(eveningRoutineStart) - timeToMinutes(currentTime);
    if (timeGap > 0) {
        if (timeGap >= 90) {
            schedule.push(createBlock('Free Time/Relaxation', currentTime, 60, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, 60);
            
            const remainingGap = timeToMinutes(eveningRoutineStart) - timeToMinutes(currentTime);
            if (remainingGap > 0) {
                schedule.push(createBlock('Evening Wind-down', currentTime, remainingGap, 'Personal', 'Low'));
            }
        } else {
            schedule.push(createBlock('Evening Relaxation', currentTime, timeGap, 'Personal', 'Low'));
        }
    }

    // Evening routine
    schedule.push(createBlock('Evening Routine & Prep', eveningRoutineStart, 45, 'Personal', 'Low'));
    
    // Bedtime
    schedule.push(createBlock(`Bedtime (${bedtimeData.sleepHours}h sleep target)`, 
        bedtimeData.bedtime, 15, 'Personal', 'Low'));

    return schedule;
}

function parseWakeTime(wakeTimeStr) {
    if (!wakeTimeStr) return '06:30'; // Default wake time
    
    const wake = new Date(wakeTimeStr);
    // Convert UTC to Pacific Time - subtract 7 hours for PDT
    const pacificHours = wake.getUTCHours() - 7;
    const pacificMinutes = wake.getUTCMinutes();
    
    // Handle negative hours (previous day)
    const adjustedHours = pacificHours < 0 ? pacificHours + 24 : pacificHours;
    
    return `${adjustedHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
}

function addMinutes(timeStr, minutes) {
    const [hours, mins] = timeStr.split(':').map(Number);
    const totalMins = hours * 60 + mins + minutes;
    const newHours = Math.floor(totalMins / 60) % 24;
    const newMins = totalMins % 60;
    return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

function calculateOptimalBedtime(morningData) {
    // Get tomorrow's likely wake time (same as today or from user preference)
    let tomorrowWakeTime = morningData.wakeTime ? parseWakeTime(morningData.wakeTime) : '06:30';
    
    // Determine optimal sleep duration based on sleep quality pattern
    let targetSleepHours = 8; // Default
    if (morningData.sleepQuality >= 8) {
        targetSleepHours = 7.5; // High quality sleep, can get by with less
    } else if (morningData.sleepQuality <= 5) {
        targetSleepHours = 8.5; // Poor quality, need more time
    }
    
    // Calculate bedtime by working backwards from wake time
    const wakeTimeMinutes = timeToMinutes(tomorrowWakeTime);
    const sleepDurationMinutes = targetSleepHours * 60;
    let bedtimeMinutes = wakeTimeMinutes - sleepDurationMinutes;
    
    // Handle negative bedtime (previous day)
    if (bedtimeMinutes < 0) {
        bedtimeMinutes += 24 * 60; // Add 24 hours
    }
    
    const bedtimeHours = Math.floor(bedtimeMinutes / 60);
    const bedtimeMins = bedtimeMinutes % 60;
    const bedtime = `${bedtimeHours.toString().padStart(2, '0')}:${bedtimeMins.toString().padStart(2, '0')}`;
    
    return {
        bedtime,
        sleepHours: targetSleepHours,
        wakeTime: tomorrowWakeTime
    };
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

        // Archive existing blocks instead of deleting
        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        if (existing.results.length > 0) {
            console.log(`🗑️ Archived ${existing.results.length} existing blocks`);
        }
    } catch (error) {
        console.warn('⚠️ Could not clear existing blocks:', error.message);
    }
}

async function createNotionBlocks(schedule, today) {
    const createdBlocks = [];

    for (const block of schedule) {
        try {
            // Create proper datetime strings in Pacific timezone
            const startDateTime = `${today}T${block.startTime}:00.000-07:00`;
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

            createdBlocks.push({ 
                notionId: response.id, 
                ...block,
                created: true 
            });
            
            console.log(`   ✅ ${block.title} (${block.startTime}-${block.endTime})`);
            
        } catch (error) {
            console.error(`   ❌ Failed: ${block.title} - ${error.message}`);
        }
    }

    return createdBlocks;
}

// ──────────────────────────────────────────────────
// 📊 DATA RETRIEVAL FUNCTIONS
// ──────────────────────────────────────────────────

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

        const schedule = timeBlocks.results.map(block => {
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const title = block.properties.Title?.title[0]?.text?.content || 'Untitled Block';
            const blockType = block.properties['Block Type']?.select?.name || 'personal';
            const energy = block.properties['Energy Requirements']?.select?.name || 'medium';

            if (!startTime) return null;

            // Convert UTC to Pacific Time for display
            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
            // Subtract 7 hours for PDT (or 8 for PST - adjust as needed)
            const startPacific = new Date(start.getTime() - (7 * 60 * 60 * 1000));
            const endPacific = end ? new Date(end.getTime() - (7 * 60 * 60 * 1000)) : null;

            return {
                time: `${startPacific.getUTCHours().toString().padStart(2, '0')}:${startPacific.getUTCMinutes().toString().padStart(2, '0')}`,
                endTime: endPacific ? `${endPacific.getUTCHours().toString().padStart(2, '0')}:${endPacific.getUTCMinutes().toString().padStart(2, '0')}` : '',
                title,
                type: blockType.toLowerCase().replace(/\s+/g, '-'),
                energy: energy.toLowerCase(),
                details: `${energy} energy • ${blockType}`,
                project: block.properties['Projects Master']?.relation?.[0]?.id || null
            };
        }).filter(block => block !== null);

        return schedule;

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
            sorts: [{ timestamp: 'created_time', direction: 'descending' }],
            page_size: 1
        });

        if (response.results.length === 0) {
            console.log('📝 No morning log found for today');
            return null;
        }

        return extractMorningData(response.results[0]);
    } catch (error) {
        console.error('❌ Failed to get morning log:', error.message);
        return null;
    }
}

function getFallbackSchedule() {
    const now = new Date();
    const currentHour = Math.max(6, now.getHours());
    
    return [
        {
            time: `${currentHour.toString().padStart(2, '0')}:00`,
            endTime: `${(currentHour + 1).toString().padStart(2, '0')}:00`,
            title: 'Morning Routine',
            type: 'personal',
            energy: 'medium',
            details: 'Default morning routine'
        },
        {
            time: `${(currentHour + 1).toString().padStart(2, '0')}:00`,
            endTime: `${(currentHour + 3).toString().padStart(2, '0')}:00`,
            title: 'Focus Work Block',
            type: 'deep-work',
            energy: 'high',
            details: 'Fallback work time'
        },
        {
            time: `${(currentHour + 3).toString().padStart(2, '0')}:00`,
            endTime: `${(currentHour + 4).toString().padStart(2, '0')}:00`,
            title: 'Admin & Planning',
            type: 'admin',
            energy: 'medium',
            details: 'Fallback admin time'
        }
    ];
}
