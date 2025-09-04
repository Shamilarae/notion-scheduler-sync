const { Client } = require('@notionhq/client');

// Initialize Notion client with error handling
let notion;
try {
    notion = new Client({ auth: process.env.NOTION_TOKEN });
} catch (error) {
    console.error('❌ Failed to initialize Notion client:', error.message);
    throw new Error('NOTION_TOKEN is required');
}

// Database constants
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar integration with graceful fallback
let calendar = null;
let calendarEnabled = false;

try {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        const { google } = require('googleapis');
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: [
                'https://www.googleapis.com/auth/calendar.readonly',
                'https://www.googleapis.com/auth/calendar'
            ],
        });

        calendar = google.calendar({ version: 'v3', auth });
        calendarEnabled = true;
        console.log('✅ Google Calendar integration enabled');
    } else {
        console.log('⚠️ Google Calendar disabled: Missing credentials');
    }
} catch (error) {
    console.error('⚠️ Google Calendar initialization failed:', error.message);
    console.log('📅 Continuing with Notion-only scheduling');
}

// FIXED: Proper calendar routing using Shamila's exact mapping
const CONTEXT_TYPE_TO_CALENDAR_ID = {
    "Personal-Events": "shamilarae@gmail.com",
    "Personal-Admin": "ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com",
    "Personal-Appointment": "0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com",
    "Family-Events": "family13053487624784455294@group.calendar.google.com",
    "Work-Travel": "oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com",
    "Work-Admin": "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    "Work-Deep Work": "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    "Work-Meeting": "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    "Work-Routine": "a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com"
};

// All calendar IDs for import scanning
const ALL_CALENDAR_IDS = [
    "shamilarae@gmail.com",
    "ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com",
    "0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com",
    "family13053487624784455294@group.calendar.google.com",
    "oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com",
    "25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com",
    "09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com",
    "80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com",
    "a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com"
];

const WORK_SCHEDULE = {
    calendarId: 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
    startDate: '2025-08-28',
    endDate: '2025-09-10',
    dailyStart: '05:30',
    dailyEnd: '17:30'
};

// UTILITY FUNCTIONS
function addMinutes(timeStr, minutes) {
    try {
        const [hours, mins] = timeStr.split(':').map(Number);
        if (isNaN(hours) || isNaN(mins)) {
            throw new Error(`Invalid time format: ${timeStr}`);
        }
        const totalMins = hours * 60 + mins + minutes;
        const newHours = Math.floor(totalMins / 60) % 24;
        const newMins = totalMins % 60;
        return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
    } catch (error) {
        console.error('Error in addMinutes:', error.message);
        return timeStr;
    }
}

function getMinutesBetween(startTime, endTime) {
    try {
        const [startHours, startMins] = startTime.split(':').map(Number);
        const [endHours, endMins] = endTime.split(':').map(Number);
        
        if (isNaN(startHours) || isNaN(startMins) || isNaN(endHours) || isNaN(endMins)) {
            throw new Error(`Invalid time format: ${startTime} to ${endTime}`);
        }
        
        const startTotalMins = startHours * 60 + startMins;
        const endTotalMins = endHours * 60 + endMins;
        return Math.max(0, endTotalMins - startTotalMins);
    } catch (error) {
        console.error('Error in getMinutesBetween:', error.message);
        return 0;
    }
}

// Dynamic timezone handling
function getPacificOffset() {
    const now = new Date();
    const january = new Date(now.getFullYear(), 0, 1);
    const july = new Date(now.getFullYear(), 6, 1);
    const stdOffset = Math.max(january.getTimezoneOffset(), july.getTimezoneOffset());
    const currentOffset = now.getTimezoneOffset();
    const isDST = currentOffset < stdOffset;
    return isDST ? -7 : -8;
}

function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        const pacificOffset = getPacificOffset();
        const pacificDateTime = new Date(`${pacificDateStr}T${pacificTimeStr}:00.000`);
        const utcDateTime = new Date(pacificDateTime.getTime() - (pacificOffset * 60 * 60 * 1000));
        return utcDateTime.toISOString();
    } catch (error) {
        console.error('Error converting Pacific to UTC:', error.message);
        return new Date().toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const pacificOffset = getPacificOffset();
        const utcDate = new Date(utcDateStr);
        const pacificDate = new Date(utcDate.getTime() + (pacificOffset * 60 * 60 * 1000));
        const hours = pacificDate.getUTCHours();
        const minutes = pacificDate.getUTCMinutes();
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    } catch (error) {
        console.error('Error converting UTC to Pacific:', error.message);
        return '09:00';
    }
}

function getPacificDateRange(pacificDateStr) {
    const pacificStartUTC = pacificTimeToUTC(pacificDateStr, '00:00');
    const pacificEndUTC = pacificTimeToUTC(pacificDateStr, '23:59');
    return { start: pacificStartUTC, end: pacificEndUTC };
}

// STEP 1: Import existing Google Calendar events
async function importExistingCalendarEvents(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, skipping import');
        return [];
    }
    
    console.log('📥 Importing existing Google Calendar events...');
    
    const dayRange = getPacificDateRange(today);
    const importedEvents = [];
    let totalEvents = 0;
    
    for (const calendarId of ALL_CALENDAR_IDS) {
        try {
            console.log(`🔍 Scanning calendar: ${calendarId.substring(0, 20)}...`);
            
            const events = await calendar.events.list({
                calendarId: calendarId,
                timeMin: dayRange.start,
                timeMax: dayRange.end,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 100
            });
            
            if (events.data.items && events.data.items.length > 0) {
                console.log(`📅 Found ${events.data.items.length} events in this calendar`);
                
                for (const event of events.data.items) {
                    // Skip all-day events and events without times
                    if (!event.start?.dateTime || !event.end?.dateTime) {
                        console.log(`⏭️ Skipping all-day/untimed event: ${event.summary || 'Untitled'}`);
                        continue;
                    }
                    
                    // Convert to Pacific time
                    const startPacific = utcToPacificTime(event.start.dateTime);
                    const endPacific = utcToPacificTime(event.end.dateTime);
                    
                    // Determine type and context based on which calendar it came from
                    const { type, context } = inferTypeAndContextFromCalendar(calendarId, event.summary || 'Imported Event');
                    
                    const importedEvent = {
                        title: event.summary || 'Imported Event',
                        startTime: startPacific,
                        endTime: endPacific,
                        duration: getMinutesBetween(startPacific, endPacific),
                        type: type,
                        context: context,
                        gCalId: event.id,
                        calendarId: calendarId,
                        description: event.description || '',
                        location: event.location || '',
                        isImported: true
                    };
                    
                    importedEvents.push(importedEvent);
                    totalEvents++;
                }
            } else {
                console.log(`📅 No events found in this calendar`);
            }
            
        } catch (error) {
            console.error(`⚠️ Error scanning calendar ${calendarId.substring(0, 20)}: ${error.message}`);
            // Continue with other calendars even if one fails
        }
    }
    
    // Sort by start time
    importedEvents.sort((a, b) => {
        const aMinutes = parseInt(a.startTime.split(':')[0]) * 60 + parseInt(a.startTime.split(':')[1]);
        const bMinutes = parseInt(b.startTime.split(':')[0]) * 60 + parseInt(b.startTime.split(':')[1]);
        return aMinutes - bMinutes;
    });
    
    console.log(`📥 Import complete: ${totalEvents} events from ${ALL_CALENDAR_IDS.length} calendars`);
    return importedEvents;
}

// Helper function to infer type/context from calendar source
function inferTypeAndContextFromCalendar(calendarId, eventTitle) {
    const eventTitleLower = eventTitle.toLowerCase();
    
    // Check each mapping to see which calendar this came from
    for (const [key, id] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
        if (id === calendarId) {
            const [context, type] = key.split('-');
            return { context, type };
        }
    }
    
    // Fallback logic based on calendar ID patterns or event title
    if (calendarId.includes('family')) {
        return { context: 'Family', type: 'Events' };
    } else if (calendarId === 'shamilarae@gmail.com') {
        if (eventTitleLower.includes('meeting') || eventTitleLower.includes('call')) {
            return { context: 'Personal', type: 'Meeting' };
        } else if (eventTitleLower.includes('appointment') || eventTitleLower.includes('doctor')) {
            return { context: 'Personal', type: 'Appointment' };
        } else {
            return { context: 'Personal', type: 'Events' };
        }
    } else {
        // Work calendar fallback
        if (eventTitleLower.includes('meeting') || eventTitleLower.includes('call')) {
            return { context: 'Work', type: 'Meeting' };
        } else if (eventTitleLower.includes('travel') || eventTitleLower.includes('flight')) {
            return { context: 'Work', type: 'Travel' };
        } else {
            return { context: 'Work', type: 'Events' };
        }
    }
}

// STEP 2: Create imported events as time blocks in Notion (if not already exist)
async function createImportedTimeBlocks(importedEvents, today) {
    console.log(`💾 Creating ${importedEvents.length} imported events in Notion...`);
    
    const created = [];
    const skipped = [];
    
    for (const event of importedEvents) {
        try {
            // Check if this event already exists in Notion (by GCal ID)
            const existingBlock = await checkExistingTimeBlock(event.gCalId);
            
            if (existingBlock) {
                console.log(`⏭️ Skipping existing block: ${event.title}`);
                skipped.push({
                    title: event.title,
                    gCalId: event.gCalId,
                    reason: 'Already exists in Notion'
                });
                continue;
            }
            
            // Create new time block for imported event
            const startUTC = pacificTimeToUTC(today, event.startTime);
            const endUTC = pacificTimeToUTC(today, event.endTime);
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: event.title } }] },
                    Type: { select: { name: event.type } },
                    Context: { select: { name: event.context } },
                    'Block Type': { select: { name: event.type } }, // Legacy compatibility
                    'Energy Requirements': { select: { name: 'Medium' } }, // Default for imported
                    Status: { select: { name: 'Active' } },
                    'Start Time': { 
                        date: { 
                            start: startUTC,
                            time_zone: 'America/Vancouver'
                        } 
                    },
                    'End Time': { 
                        date: { 
                            start: endUTC,
                            time_zone: 'America/Vancouver'
                        } 
                    },
                    'GCal ID': { rich_text: [{ text: { content: event.gCalId } }] },
                    'Auto-Filled': { checkbox: false }, // Imported events are NOT auto-filled
                    Notes: { 
                        rich_text: [{ 
                            text: { 
                                content: `Imported from Google Calendar\nSource: ${event.calendarId.substring(0, 30)}...\n\n${event.description}\n\nLocation: ${event.location}\n\nImported: ${new Date().toLocaleString()}`
                            } 
                        }] 
                    }
                }
            });
            
            console.log(`✅ Created imported block: ${event.title} (${event.startTime}-${event.endTime})`);
            
            created.push({
                title: event.title,
                startTime: event.startTime,
                endTime: event.endTime,
                type: event.type,
                context: event.context,
                gCalId: event.gCalId,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create imported block "${event.title}":`, error.message);
            skipped.push({
                title: event.title,
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    console.log(`💾 Import to Notion complete: ${created.length} created, ${skipped.length} skipped`);
    return { created, skipped };
}

// Helper: Check if time block already exists by GCal ID
async function checkExistingTimeBlock(gCalId) {
    try {
        const existingBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'GCal ID',
                rich_text: { contains: gCalId }
            },
            page_size: 1
        });
        
        return existingBlocks.results.length > 0 ? existingBlocks.results[0] : null;
    } catch (error) {
        console.error('Error checking existing time block:', error.message);
        return null;
    }
}

// STEP 3: Get enhanced morning log data
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '04:30',
        energy: 7,
        mood: 'Steady',
        focusCapacity: 'Normal',
        socialBattery: 'Full',
        bodyStatus: 'Normal',
        stressLevel: 'Normal',
        weatherImpact: 'None',
        sleepHours: 7,
        sleepQuality: 7
    };
    
    try {
        const morningLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        if (morningLogResponse.results.length === 0) {
            console.log('⚠️ No morning log found for today, using defaults');
            return defaultData;
        }

        const log = morningLogResponse.results[0].properties;
        const data = { ...defaultData };
        
        // Safe extraction with fallbacks
        try {
            const wakeTimeRaw = log['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                data.wakeTime = utcToPacificTime(wakeTimeRaw);
            }
        } catch (error) {
            console.error('Error parsing wake time:', error.message);
        }
        
        const safeExtract = (propName, fallback) => {
            try {
                return log[propName]?.select?.name || fallback;
            } catch {
                return fallback;
            }
        };
        
        const safeExtractNumber = (propName, fallback) => {
            try {
                const value = log[propName]?.number;
                return (value !== null && value !== undefined && !isNaN(value)) ? value : fallback;
            } catch {
                return fallback;
            }
        };
        
        const energyValue = log['Energy']?.select?.name;
        if (energyValue && !isNaN(parseInt(energyValue))) {
            data.energy = parseInt(energyValue);
        }
        
        data.mood = safeExtract('Mood', 'Steady');
        data.focusCapacity = safeExtract('Focus Capacity', 'Normal');
        data.socialBattery = safeExtract('Social Battery', 'Full');
        data.bodyStatus = safeExtract('Body Status', 'Normal');
        data.stressLevel = safeExtract('Stress Level', 'Normal');
        data.weatherImpact = safeExtract('Weather Impact', 'None');
        data.sleepHours = safeExtractNumber('Sleep Hours', 7);
        data.sleepQuality = safeExtractNumber('Sleep Quality', 7);
        
        console.log('✅ Successfully parsed morning log data');
        return data;
        
    } catch (error) {
        console.error('❌ Error fetching morning log:', error.message);
        return defaultData;
    }
}

// STEP 4: Calculate AI adjustments (same robust logic as before)
function calculateAdjustedParameters(morningData) {
    let adjustments = {
        energyMultiplier: 1.0,
        focusMultiplier: 1.0,
        blockDurationMultiplier: 1.0,
        breakFrequencyMultiplier: 1.0,
        deepWorkCapacity: 1.0,
        socialToleranceMultiplier: 1.0,
        optimizations: {}
    };
    
    const energy = Math.max(1, Math.min(10, morningData.energy || 7));
    const sleepHours = Math.max(0, Math.min(12, morningData.sleepHours || 7));
    
    // Sleep impact analysis
    if (sleepHours < 5) {
        adjustments.energyMultiplier *= 0.6;
        adjustments.focusMultiplier *= 0.5;
        adjustments.blockDurationMultiplier *= 0.7;
        adjustments.breakFrequencyMultiplier *= 1.5;
        adjustments.deepWorkCapacity = 0.2;
        adjustments.optimizations.sleep = "Severe sleep deficit: Recovery mode activated";
    } else if (sleepHours < 6.5) {
        adjustments.energyMultiplier *= 0.8;
        adjustments.focusMultiplier *= 0.8;
        adjustments.blockDurationMultiplier *= 0.85;
        adjustments.breakFrequencyMultiplier *= 1.3;
        adjustments.deepWorkCapacity *= 0.6;
        adjustments.optimizations.sleep = "Sleep deficit: Reduced capacity";
    } else if (sleepHours > 8.5) {
        adjustments.energyMultiplier *= 1.1;
        adjustments.focusMultiplier *= 1.1;
        adjustments.deepWorkCapacity *= 1.2;
        adjustments.optimizations.sleep = "Excellent sleep: Enhanced performance";
    }
    
    // Body status, stress, weather, mood adjustments (same logic as before)
    switch (morningData.bodyStatus) {
        case 'Sick':
            adjustments.energyMultiplier *= 0.3;
            adjustments.focusMultiplier *= 0.4;
            adjustments.blockDurationMultiplier *= 0.5;
            adjustments.breakFrequencyMultiplier *= 2.0;
            adjustments.deepWorkCapacity = 0;
            adjustments.optimizations.body = "Sick: Full recovery mode";
            break;
        case 'Achy':
            adjustments.energyMultiplier *= 0.7;
            adjustments.blockDurationMultiplier *= 0.8;
            adjustments.breakFrequencyMultiplier *= 1.4;
            adjustments.deepWorkCapacity *= 0.6;
            adjustments.optimizations.body = "Physical discomfort: Gentle schedule";
            break;
        case 'Strong':
            adjustments.energyMultiplier *= 1.15;
            adjustments.deepWorkCapacity *= 1.3;
            adjustments.blockDurationMultiplier *= 1.1;
            adjustments.optimizations.body = "Peak physical state: Enhanced capacity";
            break;
        default:
            adjustments.optimizations.body = "Normal physical state: Standard capacity";
    }
    
    switch (morningData.stressLevel) {
        case 'Maxed Out':
            adjustments.focusMultiplier *= 0.5;
            adjustments.deepWorkCapacity *= 0.3;
            adjustments.socialToleranceMultiplier *= 0.4;
            adjustments.blockDurationMultiplier *= 0.7;
            adjustments.optimizations.stress = "Critical stress: Minimal cognitive load";
            break;
        case 'Elevated':
            adjustments.focusMultiplier *= 0.8;
            adjustments.deepWorkCapacity *= 0.7;
            adjustments.socialToleranceMultiplier *= 0.7;
            adjustments.optimizations.stress = "Elevated stress: Reduced complexity";
            break;
        case 'Zen':
            adjustments.focusMultiplier *= 1.2;
            adjustments.deepWorkCapacity *= 1.4;
            adjustments.socialToleranceMultiplier *= 1.3;
            adjustments.optimizations.stress = "Zen state: Optimal for intensive work";
            break;
        default:
            adjustments.optimizations.stress = "Normal stress level: Standard approach";
    }
    
    switch (morningData.mood) {
        case 'Fired Up':
            adjustments.energyMultiplier *= 1.2;
            adjustments.deepWorkCapacity *= 1.3;
            adjustments.socialToleranceMultiplier *= 1.2;
            adjustments.optimizations.mood = "High energy mood: Aggressive scheduling";
            break;
        case 'Drained':
            adjustments.energyMultiplier *= 0.7;
            adjustments.focusMultiplier *= 0.8;
            adjustments.deepWorkCapacity *= 0.5;
            adjustments.breakFrequencyMultiplier *= 1.4;
            adjustments.optimizations.mood = "Drained mood: Recovery-focused approach";
            break;
        case 'Scattered':
            adjustments.focusMultiplier *= 0.6;
            adjustments.blockDurationMultiplier *= 0.7;
            adjustments.deepWorkCapacity *= 0.4;
            adjustments.optimizations.mood = "Scattered mood: Short, varied tasks";
            break;
        default:
            adjustments.optimizations.mood = "Steady mood: Balanced approach";
    }
    
    // Bounds checking
    adjustments.energyMultiplier = Math.max(0.2, Math.min(1.5, adjustments.energyMultiplier));
    adjustments.focusMultiplier = Math.max(0.2, Math.min(1.5, adjustments.focusMultiplier));
    adjustments.blockDurationMultiplier = Math.max(0.3, Math.min(1.3, adjustments.blockDurationMultiplier));
    adjustments.breakFrequencyMultiplier = Math.max(0.7, Math.min(2.5, adjustments.breakFrequencyMultiplier));
    adjustments.deepWorkCapacity = Math.max(0, Math.min(1.5, adjustments.deepWorkCapacity));
    adjustments.socialToleranceMultiplier = Math.max(0.3, Math.min(1.5, adjustments.socialToleranceMultiplier));
    
    const totalEnergyScore = energy * adjustments.energyMultiplier;
    const focusCapacityScore = morningData.focusCapacity === 'Sharp' ? 10 : 
                              morningData.focusCapacity === 'Normal' ? 7 : 4;
    const totalFocusScore = focusCapacityScore * adjustments.focusMultiplier;
    
    if (totalEnergyScore >= 9 && totalFocusScore >= 8 && adjustments.deepWorkCapacity >= 1.0) {
        adjustments.optimizations.compound = "🚀 PEAK STATE: All systems optimal for maximum output";
    } else if (totalEnergyScore <= 4 || totalFocusScore <= 3 || adjustments.deepWorkCapacity <= 0.3) {
        adjustments.optimizations.compound = "🏥 RECOVERY MODE: Multiple limiting factors detected";
    } else {
        adjustments.optimizations.compound = "📊 MIXED STATE: Optimization applied";
    }
    
    return {
        ...adjustments,
        adjustedEnergy: Math.round(totalEnergyScore * 10) / 10,
        adjustedFocus: Math.round(totalFocusScore * 10) / 10,
        recommendedMaxBlockDuration: Math.round(Math.max(30, Math.min(120, 60 * adjustments.blockDurationMultiplier))),
        recommendedBreakInterval: Math.round(Math.max(45, Math.min(180, 90 / adjustments.breakFrequencyMultiplier)))
    };
}

// STEP 5: Generate AI schedule around existing events
async function generateAIScheduleAroundFixedEvents(existingEvents, morningData, adjustedParams, workShift) {
    console.log('🧠 Generating AI schedule around existing calendar events...');
    
    // Sort existing events by time
    const sortedEvents = [...existingEvents].sort((a, b) => {
        const aMinutes = parseInt(a.startTime.split(':')[0]) * 60 + parseInt(a.startTime.split(':')[1]);
        const bMinutes = parseInt(b.startTime.split(':')[0]) * 60 + parseInt(b.startTime.split(':')[1]);
        return aMinutes - bMinutes;
    });
    
    const aiGeneratedBlocks = [];
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    const isRecoveryMode = adjustedParams.optimizations.compound?.includes('RECOVERY MODE');
    const isPeakState = adjustedParams.optimizations.compound?.includes('PEAK STATE');
    
    let currentTime = morningData.wakeTime;
    const endOfDay = '22:00';
    
    // Add morning routine block first
    const routineDuration = isRecoveryMode ? 90 : (adjustedParams.adjustedEnergy >= 7 ? 45 : 60);
    aiGeneratedBlocks.push({
        title: isRecoveryMode ? 'Extended Recovery Morning' : 
               isPeakState ? 'Peak State Morning Prep' : 'Morning Routine',
        startTime: currentTime,
        duration: routineDuration,
        type: 'Events',
        context: 'Personal',
        energy: 'Low',
        rationale: `Adaptive morning routine: ${routineDuration}min based on state analysis`
    });
    currentTime = addMinutes(currentTime, routineDuration);
    
    // Generate blocks in available time slots between existing events
    for (let i = 0; i <= sortedEvents.length; i++) {
        const slotStart = currentTime;
        const slotEnd = i < sortedEvents.length ? sortedEvents[i].startTime : endOfDay;
        const availableMinutes = getMinutesBetween(slotStart, slotEnd);
        
        if (availableMinutes >= 30) {
            console.log(`🕐 Available slot: ${slotStart} to ${slotEnd} (${availableMinutes} min)`);
            
            // Generate blocks for this time slot
            const slotsBlocks = generateBlocksForTimeSlot(
                slotStart, 
                slotEnd, 
                availableMinutes,
                adjustedParams,
                workShift,
                isRecoveryMode,
                isPeakState
            );
            
            aiGeneratedBlocks.push(...slotsBlocks);
        }
        
        // Update currentTime to end of current event (if exists)
        if (i < sortedEvents.length) {
            currentTime = sortedEvents[i].endTime;
        }
    }
    
    console.log(`🧠 Generated ${aiGeneratedBlocks.length} AI-optimized time blocks`);
    return aiGeneratedBlocks;
}

// Helper: Generate blocks for a specific available time slot
function generateBlocksForTimeSlot(slotStart, slotEnd, availableMinutes, adjustedParams, workShift, isRecoveryMode, isPeakState) {
    const blocks = [];
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    const breakInterval = adjustedParams.recommendedBreakInterval;
    
    let currentTime = slotStart;
    const currentHour = parseInt(slotStart.split(':')[0]);
    
    // Determine if this is work hours
    const isWorkHours = workShift.isWorkDay && 
                       currentHour >= parseInt(workShift.startTime.split(':')[0]) && 
                       currentHour < parseInt(workShift.endTime.split(':')[0]);
    
    while (getMinutesBetween(currentTime, slotEnd) >= 30) {
        const remainingMinutes = getMinutesBetween(currentTime, slotEnd);
        let blockType, blockTitle, blockContext, blockDuration, blockEnergy;
        
        // Intelligent block assignment based on time, state, and capacity
        if (isRecoveryMode) {
            // Recovery mode: gentle tasks only
            blockType = 'Admin';
            blockTitle = 'Light Recovery Tasks';
            blockContext = isWorkHours ? 'Work' : 'Personal';
            blockDuration = Math.min(30, maxBlockDuration, remainingMinutes);
            blockEnergy = 'Low';
            
        } else if (currentHour >= 5 && currentHour < 9 && adjustedParams.deepWorkCapacity >= 0.8) {
            // Peak morning hours with good capacity
            blockType = 'Deep Work';
            blockTitle = isPeakState ? 'Peak Performance Deep Work' : 'Morning Deep Work';
            blockContext = 'Work';
            blockDuration = Math.min(isPeakState ? 90 : maxBlockDuration, remainingMinutes);
            blockEnergy = adjustedParams.adjustedEnergy >= 8 ? 'High' : 'Medium';
            
        } else if (currentHour >= 9 && currentHour < 12 && adjustedParams.adjustedFocus >= 7) {
            // Mid-morning with good focus
            if (adjustedParams.deepWorkCapacity >= 0.7) {
                blockType = adjustedParams.adjustedEnergy >= 8 ? 'Deep Work' : 'Admin';
                blockTitle = 'Focused Work Session';
                blockContext = 'Work';
                blockDuration = Math.min(maxBlockDuration, remainingMinutes);
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Morning Admin';
                blockContext = isWorkHours ? 'Work' : 'Personal';
                blockDuration = Math.min(45, maxBlockDuration, remainingMinutes);
                blockEnergy = 'Medium';
            }
            
        } else if (currentHour === 12) {
            // Lunch time
            blockType = 'Events';
            blockTitle = isRecoveryMode ? 'Extended Lunch & Recovery' : 'Lunch Break';
            blockContext = 'Personal';
            blockDuration = Math.min(isRecoveryMode ? 75 : 60, remainingMinutes);
            blockEnergy = 'Low';
            
        } else if (currentHour >= 13 && currentHour < 15) {
            // Post-lunch hours
            if (adjustedParams.adjustedEnergy >= 7 && adjustedParams.deepWorkCapacity >= 0.6) {
                blockType = 'Admin';
                blockTitle = 'Afternoon Project Work';
                blockContext = isWorkHours ? 'Work' : 'Personal';
                blockDuration = Math.min(maxBlockDuration, remainingMinutes);
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Light Afternoon Tasks';
                blockContext = isWorkHours ? 'Work' : 'Personal';
                blockDuration = Math.min(45, remainingMinutes);
                blockEnergy = 'Low';
            }
            
        } else if (currentHour >= 15 && currentHour < 17) {
            // Late afternoon
            blockType = 'Events';
            blockTitle = 'Riley Time' + (currentHour >= 16 ? ' (After School)' : '');
            blockContext = 'Riley';
            blockDuration = Math.min(60, remainingMinutes);
            blockEnergy = 'Medium';
            
        } else if (currentHour >= 17 && currentHour < 20) {
            // Evening hours
            blockType = 'Events';
            blockTitle = currentHour >= 18 ? 'Family Dinner Time' : 'Family Time';
            blockContext = 'Family';
            blockDuration = Math.min(60, remainingMinutes);
            blockEnergy = 'Low';
            
        } else {
            // Night hours
            blockType = 'Events';
            blockTitle = 'Personal Wind Down';
            blockContext = 'Personal';
            blockDuration = Math.min(60, remainingMinutes);
            blockEnergy = 'Low';
        }
        
        // Create the block
        blocks.push({
            title: blockTitle,
            startTime: currentTime,
            duration: blockDuration,
            type: blockType,
            context: blockContext,
            energy: blockEnergy,
            rationale: `AI Generated: ${blockDuration}min ${blockType} for ${currentHour}:00 slot (${adjustedParams.adjustedEnergy.toFixed(1)} energy, ${adjustedParams.deepWorkCapacity.toFixed(1)} capacity)`
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
        
        // Add break if needed and space allows
        const timeSinceStart = getMinutesBetween(slotStart, currentTime);
        const remainingAfterBreak = getMinutesBetween(currentTime, slotEnd);
        
        if (timeSinceStart >= breakInterval && remainingAfterBreak >= 45 && blockEnergy !== 'Low') {
            const breakDuration = isRecoveryMode ? 20 : 15;
            
            blocks.push({
                title: 'Energy Break',
                startTime: currentTime,
                duration: breakDuration,
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                rationale: `Adaptive break: ${breakDuration}min after ${timeSinceStart}min of activity`
            });
            
            currentTime = addMinutes(currentTime, breakDuration);
        }
    }
    
    return blocks;
}

// STEP 6: Create AI-generated time blocks in Notion
async function createAIGeneratedTimeBlocks(aiBlocks, today, dailyLogId) {
    console.log(`💾 Creating ${aiBlocks.length} AI-generated time blocks...`);
    
    const results = [];
    
    for (const [index, block] of aiBlocks.entries()) {
        try {
            const endTime = addMinutes(block.startTime, block.duration);
            const startUTC = pacificTimeToUTC(today, block.startTime);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            console.log(`📝 Creating AI block ${index + 1}/${aiBlocks.length}: ${block.title} (${block.startTime}-${endTime})`);
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: block.title } }] },
                    Type: { select: { name: block.type } },
                    Context: { select: { name: block.context } },
                    'Energy Requirements': { select: { name: block.energy } },
                    Status: { select: { name: 'Active' } },
                    'Start Time': { 
                        date: { 
                            start: startUTC,
                            time_zone: 'America/Vancouver'
                        } 
                    },
                    'End Time': { 
                        date: { 
                            start: endUTC,
                            time_zone: 'America/Vancouver'
                        } 
                    },
                    'Auto-Filled': { checkbox: true }, // AI-generated blocks are auto-filled
                    'Daily Logs': dailyLogId ? { relation: [{ id: dailyLogId }] } : undefined,
                    Notes: { 
                        rich_text: [{ 
                            text: { 
                                content: `${block.rationale}\n\nType: ${block.type} | Context: ${block.context}\nEnergy: ${block.energy} | Duration: ${block.duration}min\n\nAI Enhanced Scheduling v2.0\nGenerated: ${new Date().toLocaleString()}`
                            } 
                        }] 
                    }
                }
            });
            
            console.log(`✅ Created AI block: ${block.type}(${block.context}) - ${block.title}`);
            
            results.push({
                title: block.title,
                startTime: block.startTime,
                endTime: endTime,
                type: block.type,
                context: block.context,
                duration: block.duration,
                rationale: block.rationale,
                notionId: timeBlockResponse.id,
                gCalId: null, // Will be populated during export
                status: 'created'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create AI block "${block.title}":`, error.message);
            results.push({
                title: block.title,
                startTime: block.startTime,
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    console.log(`💾 AI block creation complete: ${results.filter(r => r.status === 'created').length} created, ${results.filter(r => r.status === 'failed').length} failed`);
    return results;
}

// STEP 7: Export new blocks to Google Calendar (only those without GCal ID)
async function exportNewBlocksToCalendar(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar export disabled, skipping sync');
        return [];
    }
    
    console.log('📤 Exporting new time blocks to Google Calendar...');
    
    // Get all today's time blocks that don't have GCal IDs yet
    const dayRange = getPacificDateRange(today);
    
    const newBlocks = await notion.databases.query({
        database_id: TIME_BLOCKS_DB_ID,
        filter: {
            and: [
                {
                    property: 'Start Time',
                    date: {
                        on_or_after: dayRange.start,
                        on_or_before: dayRange.end
                    }
                },
                {
                    property: 'GCal ID',
                    rich_text: { is_empty: true }
                }
            ]
        },
        page_size: 100
    });
    
    console.log(`📤 Found ${newBlocks.results.length} blocks ready for calendar export`);
    
    const exportResults = [];
    
    for (const block of newBlocks.results) {
        try {
            const title = block.properties.Title?.title?.[0]?.text?.content || 'Untitled';
            const type = block.properties.Type?.select?.name || 'Events';
            const context = block.properties.Context?.select?.name || 'Personal';
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            const notes = block.properties.Notes?.rich_text?.[0]?.text?.content || '';
            
            if (!startTime || !endTime) {
                console.log(`⏭️ Skipping block with missing times: ${title}`);
                continue;
            }
            
            // Get the appropriate calendar for this block
            const routingKey = `${context}-${type}`;
            const calendarId = CONTEXT_TYPE_TO_CALENDAR_ID[routingKey] || "shamilarae@gmail.com";
            
            console.log(`📤 Exporting "${title}" to ${routingKey} -> ${calendarId.substring(0, 20)}...`);
            
            // Create the calendar event
            const event = {
                summary: title,
                description: `${notes}\n\nType: ${type} | Context: ${context}\nEnhanced AI Scheduler v2.0`,
                start: {
                    dateTime: startTime,
                    timeZone: 'America/Vancouver'
                },
                end: {
                    dateTime: endTime,
                    timeZone: 'America/Vancouver'
                }
            };
            
            const response = await calendar.events.insert({
                calendarId: calendarId,
                resource: event
            });
            
            // Update the Notion block with the new GCal ID
            await notion.pages.update({
                page_id: block.id,
                properties: {
                    'GCal ID': {
                        rich_text: [{ text: { content: response.data.id } }]
                    }
                }
            });
            
            console.log(`✅ Exported and linked: ${title} (${response.data.id})`);
            
            exportResults.push({
                title: title,
                type: type,
                context: context,
                calendarId: calendarId,
                gCalId: response.data.id,
                notionId: block.id,
                status: 'exported'
            });
            
        } catch (error) {
            console.error(`❌ Failed to export block "${block.properties.Title?.title?.[0]?.text?.content}":`, error.message);
            
            exportResults.push({
                title: block.properties.Title?.title?.[0]?.text?.content || 'Unknown',
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    console.log(`📤 Calendar export complete: ${exportResults.filter(r => r.status === 'exported').length} exported, ${exportResults.filter(r => r.status === 'failed').length} failed`);
    return exportResults;
}

// STEP 8: Clear only AI-generated blocks (Auto-Filled = true) before regenerating
async function clearAutoFilledBlocks(today) {
    try {
        console.log('🧹 Clearing existing AI-generated blocks...');
        
        const dayRange = getPacificDateRange(today);
        
        const autoFilledBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Start Time',
                        date: {
                            on_or_after: dayRange.start,
                            on_or_before: dayRange.end
                        }
                    },
                    {
                        property: 'Auto-Filled',
                        checkbox: { equals: true }
                    }
                ]
            },
            page_size: 100
        });

        console.log(`🧹 Found ${autoFilledBlocks.results.length} AI-generated blocks to clear`);

        let cleared = 0;
        let failed = 0;

        for (const block of autoFilledBlocks.results) {
            try {
                // Archive the block
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
                cleared++;
            } catch (error) {
                console.error(`⚠️ Failed to clear block ${block.id}:`, error.message);
                failed++;
            }
        }

        console.log(`✅ Cleared ${cleared} AI blocks, ${failed} failures`);
        
    } catch (error) {
        console.error('⚠️ Error clearing auto-filled blocks:', error.message);
    }
}

// MAIN ORCHESTRATOR: Complete bi-directional sync workflow
async function runBidirectionalSync(today) {
    console.log('🚀 Starting bi-directional calendar sync workflow...');
    
    const results = {
        imported: { created: [], skipped: [] },
        morningData: null,
        adjustedParams: null,
        aiGenerated: [],
        exported: [],
        workShift: { isWorkDay: false },
        errors: []
    };
    
    try {
        // STEP 1: Clear existing AI blocks (preserve imported events)
        await clearAutoFilledBlocks(today);
        
        // STEP 2: Import existing Google Calendar events
        const importedEvents = await importExistingCalendarEvents(today);
        results.imported = await createImportedTimeBlocks(importedEvents, today);
        
        // STEP 3: Get morning log and calculate adjustments
        results.morningData = await getEnhancedMorningLog(today);
        results.adjustedParams = calculateAdjustedParameters(results.morningData);
        
        // STEP 4: Check work schedule
        results.workShift = await getWorkShift(today);
        
        // STEP 5: Generate AI schedule around existing events
        const aiBlocks = await generateAIScheduleAroundFixedEvents(
            importedEvents, 
            results.morningData, 
            results.adjustedParams,
            results.workShift
        );
        
        // STEP 6: Create AI blocks in Notion
        const dailyLogId = await getDailyLogId(today);
        results.aiGenerated = await createAIGeneratedTimeBlocks(aiBlocks, today, dailyLogId);
        
        // STEP 7: Export new blocks to Google Calendar
        results.exported = await exportNewBlocksToCalendar(today);
        
        console.log('🎉 Bi-directional sync completed successfully');
        
    } catch (error) {
        console.error('❌ Bi-directional sync failed:', error.message);
        results.errors.push({
            step: 'sync_workflow',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
    
    return results;
}

// Helper: Get daily log ID for relation linking
async function getDailyLogId(today) {
    try {
        const dailyLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        return dailyLogResponse.results.length > 0 ? dailyLogResponse.results[0].id : null;
    } catch (error) {
        console.error('Error getting daily log ID:', error.message);
        return null;
    }
}

// Helper: Check work schedule
async function getWorkShift(today) {
    try {
        const workStart = new Date(WORK_SCHEDULE.startDate);
        const workEnd = new Date(WORK_SCHEDULE.endDate);
        const checkDate = new Date(today);
        
        const isInWorkPeriod = checkDate >= workStart && checkDate <= workEnd;
        const isWeekday = checkDate.getDay() >= 1 && checkDate.getDay() <= 5;
        
        return {
            isWorkDay: isInWorkPeriod && isWeekday,
            startTime: WORK_SCHEDULE.dailyStart,
            endTime: WORK_SCHEDULE.dailyEnd,
            title: isInWorkPeriod && isWeekday ? 'Work Day' : 'Home Day'
        };
    } catch (error) {
        console.error('Error checking work schedule:', error.message);
        return { isWorkDay: false, startTime: '09:00', endTime: '17:00', title: 'Home Day' };
    }
}

// Display current schedule (read-only operation)
async function getCurrentSchedule(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: dayRange.start,
                    on_or_before: dayRange.end
                }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 100
        });

        if (timeBlocks.results.length === 0) {
            return [];
        }

        const schedule = timeBlocks.results.map(block => {
            try {
                const startTime = block.properties['Start Time']?.date?.start;
                const endTime = block.properties['End Time']?.date?.start;
                const title = block.properties.Title?.title?.[0]?.text?.content || 'Untitled';
                const type = block.properties.Type?.select?.name || 'Events';
                const context = block.properties.Context?.select?.name || 'Personal';
                const autoFilled = block.properties['Auto-Filled']?.checkbox || false;
                const gCalId = block.properties['GCal ID']?.rich_text?.[0]?.text?.content || '';

                if (!startTime) return null;

                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                // Verify this is today's block
                const startUTC = new Date(startTime);
                const pacificStart = new Date(startUTC.getTime() + (getPacificOffset() * 60 * 60 * 1000));
                const pacificDateStr = pacificStart.toISOString().split('T')[0];
                
                if (pacificDateStr !== today) return null;

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: type.toLowerCase().replace(/\s+/g, '-'),
                    energy: 'medium',
                    details: `${context} • ${type}${autoFilled ? ' • AI Enhanced' : ''}${gCalId ? ' • Synced' : ' • Local Only'}`
                };
            } catch (error) {
                console.error('Error processing schedule block:', error.message);
                return null;
            }
        }).filter(block => block !== null);

        return schedule;

    } catch (error) {
        console.error('Failed to get current schedule:', error.message);
        return [];
    }
}

// MAIN VERCEL HANDLER
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('🚀 Idempotent Bi-Directional Scheduler API v2.0');
        
        if (!process.env.NOTION_TOKEN) {
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing NOTION_TOKEN'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        const requestId = `req_${Date.now()}`;
        
        console.log(`📋 Request ${requestId}: action=${action}, date=${today}`);

        // Handle bi-directional sync
        if (action === 'create') {
            console.log('🔄 Running complete bi-directional sync...');
            
            const syncResults = await runBidirectionalSync(today);
            
            // Store global results for debugging
            global.lastCreationResult = {
                success: syncResults.aiGenerated.filter(b => b.status === 'created').length,
                failed: syncResults.aiGenerated.filter(b => b.status === 'failed').length,
                imported: syncResults.imported.created.length,
                exported: syncResults.exported.filter(e => e.status === 'exported').length,
                adjustedParams: syncResults.adjustedParams,
                morningData: syncResults.morningData,
                workDay: syncResults.workShift.isWorkDay,
                optimizations: syncResults.adjustedParams ? Object.keys(syncResults.adjustedParams.optimizations).length : 0,
                calendarEnabled: calendarEnabled,
                errors: syncResults.errors,
                timestamp: new Date().toISOString()
            };
        }

        // Always fetch and return current schedule
        const schedule = await getCurrentSchedule(today);
        const now = new Date();
        const processingTime = Date.now() - startTime;
        
        const response = {
            schedule: schedule,
            meta: {
                totalBlocks: schedule.length,
                creationAttempted: action === 'create',
                lastCreationResult: global.lastCreationResult || null,
                processingTimeMs: processingTime,
                timestamp: now.toISOString(),
                version: '2.0-Bidirectional',
                calendarEnabled: calendarEnabled,
                requestId: requestId,
                workflow: 'Import → AI Schedule → Export'
            },
            display: {
                lastUpdate: now.toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    timeZone: 'America/Vancouver'
                }),
                date: now.toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                }),
                timezone: 'Pacific Time'
            }
        };

        if (global.lastCreationResult?.adjustedParams?.optimizations) {
            response.meta.optimizations = {
                count: Object.keys(global.lastCreationResult.adjustedParams.optimizations).length,
                applied: global.lastCreationResult.adjustedParams.optimizations
            };
        }

        console.log(`✅ Request ${requestId} completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('❌ Bi-Directional Scheduler Error:', error.message);
        
        res.status(500).json({ 
            error: 'Bi-directional sync failed',
            details: error.message,
            troubleshooting: {
                workflow: 'Import existing events → Generate AI schedule → Export to calendars',
                duplicatePrevention: 'Only creates calendar events for blocks without GCal IDs',
                commonIssues: [
                    'Missing Google Calendar credentials',
                    'Notion database permission issues',
                    'Calendar API rate limits'
                ]
            },
            meta: {
                version: '2.0-Bidirectional',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
}
