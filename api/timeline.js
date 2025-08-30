async function detectWorkContext(today) {
    if (!googleAvailable || !calendar) {
        console.log('📅 Google Calendar not available - defaulting to home context');
        return { 
            location: 'home', 
            type: 'default', 
            workEvents: [],
            note: 'Add GOOGLE_SERVICE_ACCOUNT env var for calendar integration'
        };
    }

    try {
        console.log('📅 Checking Google Calendar for work context...');
        
        // Get today's date range
        const startOfDay = new Date(`${today}T00:00:00-07:00`).toISOString();
        const endOfDay = new Date(`${today}T23:59:59-07:00`).toISOString();

        // Check work-related calendars for rotation indicators
        const workCalendars = [
            'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com', // Work Travel
            '25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com', // Work Admin
            '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com', // Work Deep Work
            'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com' // Work Routine
        ];

        let allWorkEvents = [];
        
        for (const calendarId of workCalendars) {
            try {
                const response = await calendar.events.list({
                    calendarId: calendarId,
                    timeMin: startOfDay,
                    timeMax: endOfDay,
                    singleEvents: true,
                    orderBy: 'startTime'
                });

                if (response.data.items) {
                    allWorkEvents.push(...response.data.items.map(event => ({
                        ...event,
                        calendarType: getCalendarType(calendarId)
                    })));
                }
            } catch (calError) {
                console.warn(`⚠️ Could not access calendar ${calendarId}:`, calError.message);
            }
        }

        console.log(`📊 Found ${allWorkEvents.length} work events today`);

        // Analyze events for rotation indicators
        const rotationKeywords = [
            'rotation', 'site', 'camp', 'field', 'remote', 'away',
            'fly in', 'fly out', 'offshore', 'project site', 'location',
            'travel', 'deployment', 'assignment'
        ];

        const travelEvents = allWorkEvents.filter(event => 
            event.calendarType === 'travel' || 
            rotationKeywords.some(keyword => 
                event.summary?.toLowerCase().includes(keyword) ||
                event.description?.toLowerCase().includes(keyword)
            )
        );

        const isOnRotation = travelEvents.length > 0 || 
            allWorkEvents.some(event => event.summary?.toLowerCase().includes('rotation'));

        const context = {
            location: isOnRotation ? 'rotation' : 'home',
            type: isOnRotation ? 'field_work' : 'home_based',
            workEvents: allWorkEvents,
            travelEvents: travelEvents,
            totalWorkEvents: allWorkEvents.length
        };

        console.log(`🎯 Context analysis: ${context.location} (${travelEvents.length} travel events)`);
        return context;

    } catch (error) {
        console.error('❌ Failed to detect work context from calendar:', error.message);
        return { location: 'home', type: 'fallback', workEvents: [] };
    }
}

function getCalendarType(calendarId) {
    if (calendarId.includes('oqfs36dkqfqhpkrpsmd146kfm4')) return 'travel';
    if (calendarId.includes('25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014')) return 'admin';
    if (calendarId.includes('09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb')) return 'deep_work';
    if (calendarId.includes('a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09')) return 'routine';
    return 'unknown';
}const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_TOKEN
});

// Initialize Google Calendar using your actual env vars
let calendar = null;
let googleAvailable = false;

if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    try {
        const { google } = require('googleapis');
        
        const credentials = {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
        };
        
        console.log('🔐 Setting up Google Calendar with:', process.env.GOOGLE_CLIENT_EMAIL);
        
        const auth = new google.auth.JWT(
            credentials.client_email,
            null,
            credentials.private_key,
            ['https://www.googleapis.com/auth/calendar']
        );
        
        calendar = google.calendar({ version: 'v3', auth });
        googleAvailable = true;
        console.log('📅 Google Calendar initialized successfully');
    } catch (error) {
        console.error('❌ Google Calendar setup failed:', error.message);
        googleAvailable = false;
    }
} else {
    console.log('⚠️ Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY environment variables');
}

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

        // If action is 'create', run the full intelligent scheduler with sync
        if (action === 'create') {
            console.log('🚀 Creating intelligent schedule with calendar sync...');
            
            // Step 1: Sync Google Calendar to Notion (pull latest events)
            if (googleAvailable) {
                await syncCalendarToNotion(today);
            }
            
            // Step 2: Create intelligent time blocks
            await createIntelligentSchedule(today);
            
            // Step 3: Push new time blocks back to Google Calendar
            if (googleAvailable) {
                await pushNotionToCalendar(today);
            }
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

    // Context detection - Are you home or on rotation?
    const context = await detectWorkContext(today);
    console.log(`🏠 Work context detected: ${context.location} (${context.type})`);

    console.log(`🎯 Starting afternoon schedule from: ${currentTime}`);
    console.log(`📊 Adjusted energy level: ${adjustedEnergy}`);
    console.log(`🧠 Focus capacity: ${focusCapacity}`);
    console.log(`🔋 Social battery: ${socialBattery}`);
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
    console.log(`🕐 Current time before afternoon blocks: ${currentTime}`);
    
    // Fill the rest of the workday until 5:30 PM
    while (currentTime < '17:30') {
        const currentMinutes = timeToMinutes(currentTime);
        const endOfDayMinutes = timeToMinutes('17:30');
        const remainingMinutes = endOfDayMinutes - currentMinutes;
        
        console.log(`⏰ Remaining work time: ${remainingMinutes} minutes from ${currentTime}`);
        
        if (remainingMinutes <= 0) break;
        
        if (remainingMinutes >= 90) {
            // 90-minute work block
            if (adjustedEnergy >= 6) {
                schedule.push(createBlock('Afternoon Deep Work', currentTime, 90, 'Deep Work', 'Medium'));
            } else {
                schedule.push(createBlock('Afternoon Admin Block', currentTime, 90, 'Admin', 'Medium'));
            }
            currentTime = addMinutes(currentTime, 90);
        } else if (remainingMinutes >= 60) {
            // 60-minute work block
            schedule.push(createBlock('End-of-Day Work', currentTime, 60, 'Admin', 'Medium'));
            currentTime = addMinutes(currentTime, 60);
        } else if (remainingMinutes >= 30) {
            // 30+ minute block
            schedule.push(createBlock('Day Wrap-up Tasks', currentTime, remainingMinutes, 'Admin', 'Low'));
            currentTime = addMinutes(currentTime, remainingMinutes);
        } else {
            // Less than 30 minutes - just finish
            schedule.push(createBlock('Final Tasks', currentTime, remainingMinutes, 'Admin', 'Low'));
            break;
        }
    }
    
    console.log(`✅ Finished work blocks at: ${currentTime}`);

    // EVENING SCHEDULE - After 5:30PM work ends
    console.log('🌅 Starting evening schedule at 5:30 PM');
    currentTime = '17:30'; // Ensure we start evening at exactly 5:30

    // Calculate bedtime first so we can plan backwards
    const bedtimeData = calculateOptimalBedtime(morningData);
    console.log(`🛏️ Calculated bedtime: ${bedtimeData.bedtime} (${bedtimeData.sleepHours}h sleep target)`);

    // Transition from work to personal time
    schedule.push(createBlock('Work to Personal Transition', currentTime, 15, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 15);

    // CONTEXT-AWARE EVENING BLOCKS
    if (context.location === 'home') {
        // At home - family time is priority
        schedule.push(createBlock('Riley Time - Family Priority', currentTime, 90, 'Riley Time', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push(createBlock('Family Dinner Time', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    } else {
        // On rotation - no family, focus on personal wellbeing
        schedule.push(createBlock('Personal Decompression', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Dinner (Solo/Crew)', currentTime, 45, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 45);
        
        // Extra personal time since no family obligations
        schedule.push(createBlock('Personal Projects/Hobbies', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    }

    // Fill evening until bedtime routine
    const eveningRoutineStart = addMinutes(bedtimeData.bedtime, -60); // 1 hour before bed
    console.log(`🌙 Evening routine starts at: ${eveningRoutineStart}`);
    
    // Fill the gap between current time and evening routine
    while (currentTime < eveningRoutineStart) {
        const currentMinutes = timeToMinutes(currentTime);
        const routineStartMinutes = timeToMinutes(eveningRoutineStart);
        const remainingMinutes = routineStartMinutes - currentMinutes;
        
        console.log(`🕐 Evening time remaining: ${remainingMinutes} minutes from ${currentTime}`);
        
        if (remainingMinutes <= 0) break;
        
        if (remainingMinutes >= 90) {
            // Long personal time block
            schedule.push(createBlock('Personal/Hobby Time', currentTime, 90, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, 90);
        } else if (remainingMinutes >= 60) {
            // Medium personal block
            schedule.push(createBlock('Evening Relaxation', currentTime, 60, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, 60);
        } else if (remainingMinutes >= 30) {
            // Short personal block
            schedule.push(createBlock('Wind-down Time', currentTime, remainingMinutes, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, remainingMinutes);
        } else {
            // Less than 30 minutes - just prep time
            schedule.push(createBlock('Pre-routine Prep', currentTime, remainingMinutes, 'Personal', 'Low'));
            break;
        }
    }

    // Evening routine - 1 hour before bed
    schedule.push(createBlock('Evening Routine & Tomorrow Prep', eveningRoutineStart, 60, 'Personal', 'Low'));
    
    // Bedtime block
    schedule.push(createBlock(`Sleep (${bedtimeData.sleepHours}h target → wake ${bedtimeData.wakeTime})`, 
        bedtimeData.bedtime, 30, 'Personal', 'Low'));

    console.log(`✅ Complete day scheduled from wake to ${bedtimeData.bedtime}`);

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

// ──────────────────────────────────────────────────
// 🔄 GOOGLE CALENDAR TWO-WAY SYNC FUNCTIONS
// ──────────────────────────────────────────────────

const CALENDAR_MAPPING = {
    "Personal_Events": "shamilarae@gmail.com",
    "Personal_Admin": "ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com",
    "Personal_Appointment": "0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com",
    "Family_Events": "family13053487624784455294@group.calendar.google.com",
    "Work_Travel": "oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com",
    "Work_Admin": "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    "Work_Deep": "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    "Work_Meeting": "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    "Work_Routine": "a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com"
};

async function syncCalendarToNotion(today) {
    if (!googleAvailable) return;
    
    console.log('📥 Syncing Google Calendar events to Notion...');
    
    const startOfDay = new Date(`${today}T00:00:00-07:00`).toISOString();
    const endOfDay = new Date(`${today}T23:59:59-07:00`).toISOString();
    
    let syncedCount = 0;
    
    for (const [contextType, calendarId] of Object.entries(CALENDAR_MAPPING)) {
        try {
            const response = await calendar.events.list({
                calendarId: calendarId,
                timeMin: startOfDay,
                timeMax: endOfDay,
                singleEvents: true,
                orderBy: 'startTime'
            });

            const events = response.data.items || [];
            console.log(`📊 Found ${events.length} events in ${contextType}`);

            for (const event of events) {
                const gcalId = event.id;
                if (!gcalId) continue;

                // Check if event already exists in Notion
                const existing = await notion.databases.query({
                    database_id: SCHEDULE_DB_ID,
                    filter: {
                        property: 'GCal ID',
                        rich_text: { equals: gcalId }
                    }
                });

                const [context, type] = contextType.split('_');
                const properties = {
                    Name: { title: [{ text: { content: event.summary || 'No Title' } }] },
                    'Start Time': { date: { start: event.start?.dateTime || event.start?.date } },
                    'End Time': { date: { start: event.end?.dateTime || event.end?.date } },
                    'GCal ID': { rich_text: [{ text: { content: gcalId } }] },
                    Context: { select: { name: context } },
                    Type: { select: { name: type } }
                };

                if (existing.results.length > 0) {
                    // Update existing
                    await notion.pages.update({
                        page_id: existing.results[0].id,
                        properties
                    });
                } else {
                    // Create new
                    await notion.pages.create({
                        parent: { database_id: SCHEDULE_DB_ID },
                        properties
                    });
                }
                syncedCount++;
            }
        } catch (error) {
            console.error(`❌ Failed to sync ${contextType}:`, error.message);
        }
    }
    
    console.log(`✅ Synced ${syncedCount} calendar events to Notion`);
}

async function pushNotionToCalendar(today) {
    if (!googleAvailable) return;
    
    console.log('📤 Pushing new Notion blocks to Google Calendar...');
    
    // Get today's time blocks (all of them - we'll push them all to calendar)
    const timeBlocksToSync = await notion.databases.query({
        database_id: TIME_BLOCKS_DB_ID,
        filter: {
            property: 'Start Time',
            date: { equals: today }
        }
    });

    let pushedCount = 0;

    for (const block of timeBlocksToSync.results) {
        try {
            const props = block.properties;
            const title = props.Title?.title?.[0]?.text?.content || 'Time Block';
            const startTime = props['Start Time']?.date?.start;
            const endTime = props['End Time']?.date?.start;
            const blockType = props['Block Type']?.select?.name || 'Personal';

            if (!startTime || !endTime) continue;

            // Determine target calendar based on block type
            let calendarId = CALENDAR_MAPPING.Personal_Events; // Default
            
            if (blockType.includes('Deep Work') || blockType.includes('Admin')) {
                calendarId = CALENDAR_MAPPING.Work_Admin;
            } else if (blockType.includes('Meeting')) {
                calendarId = CALENDAR_MAPPING.Work_Meeting;
            } else if (blockType.includes('Riley') || blockType.includes('Family')) {
                calendarId = CALENDAR_MAPPING.Family_Events;
            }

            // Create event in Google Calendar
            const event = {
                summary: title,
                start: { dateTime: startTime },
                end: { dateTime: endTime },
                description: `Created by Ash's AI Scheduler\nBlock Type: ${blockType}`
            };

            const createdEvent = await calendar.events.insert({
                calendarId: calendarId,
                resource: event
            });

            // Update Notion block with GCal ID
            await notion.pages.update({
                page_id: block.id,
                properties: {
                    // Add GCal ID property if your Time Blocks database has it
                    // Remove this line if the property doesn't exist
                    // 'GCal ID': { rich_text: [{ text: { content: createdEvent.data.id } }] }
                }
            });

            pushedCount++;
            console.log(`   ✅ ${title} → Google Calendar`);

        } catch (error) {
            console.error(`   ❌ Failed to push block:`, error.message);
        }
    }

    console.log(`✅ Pushed ${pushedCount} new blocks to Google Calendar`);
}
