const { Client } = require('@notionhq/client');

// Single notion client - declared only once
const notionClient = new Client({
    auth: process.env.NOTION_TOKEN
});

// Database IDs
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const SCHEDULE_DB_ID = process.env.DATABASE_ID_SCHEDULE;

// Google Calendar variables
let calendar = null;
let googleAvailable = false;

// Calendar mapping
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

async function initializeGoogleCalendar() {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        try {
            const { google } = require('googleapis');
            
            const credentials = {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
            };
            
            const auth = new google.auth.JWT(
                credentials.client_email,
                null,
                credentials.private_key,
                ['https://www.googleapis.com/auth/calendar']
            );
            
            calendar = google.calendar({ version: 'v3', auth });
            googleAvailable = true;
            console.log('Google Calendar initialized successfully');
            return true;
        } catch (error) {
            console.error('Google Calendar setup failed:', error.message);
            googleAvailable = false;
            return false;
        }
    } else {
        console.log('Missing Google Calendar credentials');
        return false;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        console.log('Intelligent Timeline API triggered');
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';

        if (action === 'create') {
            console.log('Creating intelligent schedule (Calendar sync temporarily disabled)...');
            
            // TEMPORARILY DISABLE CALENDAR SYNC to fix core scheduling
            // await initializeGoogleCalendar();
            // if (googleAvailable) {
            //     await syncCalendarToNotion(today);
            // }
            
            // Focus on just creating the intelligent schedule
            await createIntelligentSchedule(today);
            
            // if (googleAvailable) {
            //     await pushNotionToCalendar(today);
            // }
        }

        const schedule = await getCurrentSchedule(today);
        const morningData = await getMorningLogData(today);

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
        console.error('Timeline API Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate timeline',
            details: error.message,
            schedule: getFallbackSchedule()
        });
    }
};

async function createIntelligentSchedule(today) {
    console.log('Analyzing morning log data...');
    
    const morningLogResponse = await notionClient.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 1
    });

    if (morningLogResponse.results.length === 0) {
        throw new Error('No morning log found for today. Complete your morning ritual first.');
    }

    const log = morningLogResponse.results[0];
    const morningData = extractMorningData(log);
    
    console.log(`Analysis Complete: Energy ${morningData.energy}/10, Focus: ${morningData.focusCapacity}`);

    const context = await detectWorkContext(today);
    console.log(`Work context detected: ${context.location} (${context.type})`);

    const schedule = generateIntelligentSchedule(morningData, context);
    console.log(`Generated ${schedule.length} intelligent time blocks`);

    await clearExistingBlocks(today);
    const createdBlocks = await createNotionBlocks(schedule, today);
    console.log(`Created ${createdBlocks.length} time blocks in Notion`);
    
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

function generateIntelligentSchedule(morningData, context) {
    const { energy, focusCapacity, socialBattery, sleepQuality } = morningData;
    
    const sleepFactor = sleepQuality < 6 ? 0.7 : sleepQuality > 8 ? 1.2 : 1.0;
    const adjustedEnergy = Math.min(10, energy * sleepFactor);

    console.log(`Adjusted energy: ${adjustedEnergy.toFixed(1)}/10 (sleep factor: ${sleepFactor})`);

    let schedule = [];
    let currentTime = parseWakeTime(morningData.wakeTime);

    // Morning routine
    schedule.push(createBlock('Morning Routine', currentTime, 60, 'Personal', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    schedule.push(createBlock('Morning Planning & Log Review', currentTime, 30, 'Admin', 'Medium'));
    currentTime = addMinutes(currentTime, 30);

    // Work blocks based on energy and focus
    if (adjustedEnergy >= 8 && focusCapacity === 'Sharp') {
        console.log('Peak performance mode activated');
        schedule.push(createBlock('Deep Work - Core Project Focus', currentTime, 150, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 150);
        
        schedule.push(createBlock('Active Movement Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Creative Development Work', currentTime, 90, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
    } else if (adjustedEnergy >= 6 && focusCapacity !== 'Scattered') {
        console.log('Standard productivity mode');
        schedule.push(createBlock('Focused Work Block', currentTime, 90, 'Deep Work', 'High'));
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push(createBlock('Movement & Refresh Break', currentTime, 15, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push(createBlock('Admin & Communications', currentTime, 60, 'Admin', 'Medium'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Creative Strategy Work', currentTime, 75, 'Creative', 'Medium'));
        currentTime = addMinutes(currentTime, 75);
        
    } else {
        console.log('Recovery mode - gentle schedule');
        schedule.push(createBlock('Light Admin & Organization', currentTime, 60, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Gentle Rest Break', currentTime, 20, 'Break', 'Low'));
        currentTime = addMinutes(currentTime, 20);
        
        schedule.push(createBlock('Review & Light Planning', currentTime, 45, 'Admin', 'Low'));
        currentTime = addMinutes(currentTime, 45);
        
        schedule.push(createBlock('Easy Creative Tasks', currentTime, 60, 'Creative', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    }

    // Lunch break
    schedule.push(createBlock('Lunch & Recharge Time', currentTime, 60, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 60);

    // SIMPLE AFTERNOON SCHEDULE - No complex loops
    console.log(`=== SIMPLE AFTERNOON SCHEDULE ===`);
    console.log(`Starting afternoon at: ${currentTime}`);
    
    // Manually create afternoon blocks until 5:30 PM
    const afternoonBlocks = [];
    
    // Calculate how much time we need to fill until 5:30 PM
    const currentMinutes = timeToMinutes(currentTime);
    const endWorkMinutes = timeToMinutes('17:30'); // 5:30 PM
    const totalAfternoonMinutes = endWorkMinutes - currentMinutes;
    
    console.log(`Need to fill ${totalAfternoonMinutes} minutes until 5:30 PM`);
    
    if (totalAfternoonMinutes > 0) {
        let remainingTime = totalAfternoonMinutes;
        let blockStartTime = currentTime;
        
        // Create blocks to fill the time
        while (remainingTime > 0) {
            let blockDuration;
            let blockTitle;
            
            if (remainingTime >= 120) {
                blockDuration = 120; // 2 hours
                blockTitle = 'Afternoon Deep Work Session';
            } else if (remainingTime >= 90) {
                blockDuration = 90; // 1.5 hours
                blockTitle = 'Afternoon Focus Block';
            } else if (remainingTime >= 60) {
                blockDuration = 60; // 1 hour
                blockTitle = 'End-of-Day Work';
            } else {
                blockDuration = remainingTime; // Whatever's left
                blockTitle = 'Final Tasks';
            }
            
            const block = createBlock(blockTitle, blockStartTime, blockDuration, 'Deep Work', 'Medium');
            afternoonBlocks.push(block);
            schedule.push(block);
            
            console.log(`Created: ${block.title} from ${block.startTime} to ${block.endTime} (${blockDuration} min)`);
            
            blockStartTime = addMinutes(blockStartTime, blockDuration);
            remainingTime -= blockDuration;
        }
        
        console.log(`Created ${afternoonBlocks.length} afternoon blocks`);
        currentTime = '17:30'; // Set to exactly 5:30 PM
    } else {
        console.log('No afternoon time to fill - already at or past 5:30 PM');
        currentTime = '17:30';
    }

    // Evening schedule after 5:30
    console.log('Starting evening schedule at 5:30 PM');
    currentTime = '17:30';

    const bedtimeData = calculateOptimalBedtime(morningData);
    console.log(`Calculated bedtime: ${bedtimeData.bedtime} (${bedtimeData.sleepHours}h sleep target)`);

    schedule.push(createBlock('Work to Personal Transition', currentTime, 15, 'Break', 'Low'));
    currentTime = addMinutes(currentTime, 15);

    // Context-aware evening blocks
    if (context.location === 'home') {
        schedule.push(createBlock('Riley Time - Family Priority', currentTime, 90, 'Riley Time', 'Medium'));
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push(createBlock('Family Dinner Time', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    } else {
        schedule.push(createBlock('Personal Decompression', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
        
        schedule.push(createBlock('Dinner (Solo/Crew)', currentTime, 45, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 45);
        
        schedule.push(createBlock('Personal Projects/Hobbies', currentTime, 60, 'Personal', 'Low'));
        currentTime = addMinutes(currentTime, 60);
    }

    // Fill evening until bedtime routine
    const eveningRoutineStart = addMinutes(bedtimeData.bedtime, -60);
    console.log(`Evening routine starts at: ${eveningRoutineStart}`);
    
    while (currentTime < eveningRoutineStart) {
        const currentMinutes = timeToMinutes(currentTime);
        const routineStartMinutes = timeToMinutes(eveningRoutineStart);
        const remainingMinutes = routineStartMinutes - currentMinutes;
        
        if (remainingMinutes <= 0) break;
        
        if (remainingMinutes >= 90) {
            schedule.push(createBlock('Personal/Hobby Time', currentTime, 90, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, 90);
        } else if (remainingMinutes >= 60) {
            schedule.push(createBlock('Evening Relaxation', currentTime, 60, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, 60);
        } else if (remainingMinutes >= 30) {
            schedule.push(createBlock('Wind-down Time', currentTime, remainingMinutes, 'Personal', 'Low'));
            currentTime = addMinutes(currentTime, remainingMinutes);
        } else {
            schedule.push(createBlock('Pre-routine Prep', currentTime, remainingMinutes, 'Personal', 'Low'));
            break;
        }
    }

    // Evening routine and bedtime
    schedule.push(createBlock('Evening Routine & Tomorrow Prep', eveningRoutineStart, 60, 'Personal', 'Low'));
    schedule.push(createBlock(`Sleep (${bedtimeData.sleepHours}h target → wake ${bedtimeData.wakeTime})`, 
        bedtimeData.bedtime, 30, 'Personal', 'Low'));

    console.log(`Complete day scheduled from wake to ${bedtimeData.bedtime}`);

    return schedule;
}

function parseWakeTime(wakeTimeStr) {
    if (!wakeTimeStr) return '06:30';
    
    const wake = new Date(wakeTimeStr);
    const pacificHours = wake.getUTCHours() - 7;
    const pacificMinutes = wake.getUTCMinutes();
    
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
    let tomorrowWakeTime = morningData.wakeTime ? parseWakeTime(morningData.wakeTime) : '06:30';
    
    let targetSleepHours = 8;
    if (morningData.sleepQuality >= 8) {
        targetSleepHours = 7.5;
    } else if (morningData.sleepQuality <= 5) {
        targetSleepHours = 8.5;
    }
    
    const wakeTimeMinutes = timeToMinutes(tomorrowWakeTime);
    const sleepDurationMinutes = targetSleepHours * 60;
    let bedtimeMinutes = wakeTimeMinutes - sleepDurationMinutes;
    
    if (bedtimeMinutes < 0) {
        bedtimeMinutes += 24 * 60;
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
        console.log('Clearing existing blocks to prevent duplicates...');
        
        const existing = await notionClient.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Start Time',
                        date: { equals: today }
                    },
                    {
                        property: 'archived',
                        checkbox: { equals: false }
                    }
                ]
            }
        });

        console.log(`Found ${existing.results.length} existing blocks to clear`);

        for (const block of existing.results) {
            await notionClient.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        if (existing.results.length > 0) {
            console.log(`Successfully archived ${existing.results.length} existing blocks`);
        }
    } catch (error) {
        console.warn('Could not clear existing blocks:', error.message);
        // Don't throw - continue with creation even if clearing fails
    }
}

async function createNotionBlocks(schedule, today) {
    const createdBlocks = [];

    for (const block of schedule) {
        try {
            const startDateTime = `${today}T${block.startTime}:00.000-07:00`;
            const endDateTime = `${today}T${block.endTime}:00.000-07:00`;

            const response = await notionClient.pages.create({
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
            
            console.log(`Created: ${block.title} (${block.startTime}-${block.endTime})`);
            
        } catch (error) {
            console.error(`Failed: ${block.title} - ${error.message}`);
        }
    }

    return createdBlocks;
}

async function detectWorkContext(today) {
    if (!googleAvailable || !calendar) {
        console.log('Google Calendar not available - defaulting to home context');
        return { 
            location: 'home', 
            type: 'default', 
            workEvents: []
        };
    }

    try {
        console.log('Checking Google Calendar for work context...');
        
        const startOfDay = new Date(`${today}T00:00:00-07:00`).toISOString();
        const endOfDay = new Date(`${today}T23:59:59-07:00`).toISOString();

        const workCalendars = [
            'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
            '25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com',
            '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com',
            'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com'
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
                console.warn(`Could not access calendar ${calendarId}:`, calError.message);
            }
        }

        console.log(`Found ${allWorkEvents.length} work events today`);

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

        console.log(`Context analysis: ${context.location} (${travelEvents.length} travel events)`);
        return context;

    } catch (error) {
        console.error('Failed to detect work context from calendar:', error.message);
        return { location: 'home', type: 'fallback', workEvents: [] };
    }
}

function getCalendarType(calendarId) {
    if (calendarId.includes('oqfs36dkqfqhpkrpsmd146kfm4')) return 'travel';
    if (calendarId.includes('25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014')) return 'admin';
    if (calendarId.includes('09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb')) return 'deep_work';
    if (calendarId.includes('a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09')) return 'routine';
    return 'unknown';
}

async function getCurrentSchedule(today) {
    try {
        const timeBlocks = await notionClient.databases.query({
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

            const start = new Date(startTime);
            const end = endTime ? new Date(endTime) : null;
            
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
        console.error('Failed to get current schedule:', error.message);
        return getFallbackSchedule();
    }
}

async function getMorningLogData(today) {
    try {
        const response = await notionClient.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: {
                property: 'Date',
                date: { equals: today }
            },
            sorts: [{ timestamp: 'created_time', direction: 'descending' }],
            page_size: 1
        });

        if (response.results.length === 0) {
            console.log('No morning log found for today');
            return null;
        }

        return extractMorningData(response.results[0]);
    } catch (error) {
        console.error('Failed to get morning log:', error.message);
        return null;
    }
}

async function syncCalendarToNotion(today) {
    if (!googleAvailable) return;
    
    console.log('Syncing Google Calendar events to Notion...');
    
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
            console.log(`Found ${events.length} events in ${contextType}`);

            for (const event of events) {
                const gcalId = event.id;
                if (!gcalId) continue;

                const existing = await notionClient.databases.query({
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
                    await notionClient.pages.update({
                        page_id: existing.results[0].id,
                        properties
                    });
                } else {
                    await notionClient.pages.create({
                        parent: { database_id: SCHEDULE_DB_ID },
                        properties
                    });
                }
                syncedCount++;
            }
        } catch (error) {
            console.error(`Failed to sync ${contextType}:`, error.message);
        }
    }
    
    console.log(`Synced ${syncedCount} calendar events to Notion`);
}

async function pushNotionToCalendar(today) {
    if (!googleAvailable) return;
    
    console.log('Pushing new Notion blocks to Google Calendar...');
    
    const timeBlocksToSync = await notionClient.databases.query({
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
            let calendarId = CALENDAR_MAPPING.Personal_Events;
            
            if (blockType.includes('Deep Work') || blockType.includes('Admin')) {
                calendarId = CALENDAR_MAPPING.Work_Admin;
            } else if (blockType.includes('Meeting')) {
                calendarId = CALENDAR_MAPPING.Work_Meeting;
            } else if (blockType.includes('Riley') || blockType.includes('Family')) {
                calendarId = CALENDAR_MAPPING.Family_Events;
            }

            const event = {
                summary: title,
                start: { dateTime: startTime },
                end: { dateTime: endTime },
                description: `Created by Ash's AI Scheduler\nBlock Type: ${blockType}`
            };

            await calendar.events.insert({
                calendarId: calendarId,
                resource: event
            });

            pushedCount++;
            console.log(`Pushed: ${title} → Google Calendar`);

        } catch (error) {
            console.error(`Failed to push block:`, error.message);
        }
    }

    console.log(`Pushed ${pushedCount} new blocks to Google Calendar`);
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
