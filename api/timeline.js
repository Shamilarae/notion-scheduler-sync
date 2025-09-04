const { Client } = require('@notionhq/client');

let notion;
try {
    notion = new Client({ auth: process.env.NOTION_TOKEN });
} catch (error) {
    console.error('❌ Failed to initialize Notion client:', error.message);
    throw new Error('NOTION_TOKEN is required');
}

const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar integration
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

// Calendar routing
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
const ALL_CALENDAR_IDS = Object.values(CONTEXT_TYPE_TO_CALENDAR_ID);

// Work site detection calendar
const WORK_SITE_CALENDAR_ID = 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com';

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
        
        // Simple same-day calculation only
        if (endTotalMins < startTotalMins) {
            console.warn(`End time ${endTime} before start time ${startTime} - assuming same day`);
            return 0;
        }
        
        return endTotalMins - startTotalMins;
    } catch (error) {
        console.error('Error in getMinutesBetween:', error.message);
        return 0;
    }
}

// FIXED: Simple, reliable timezone conversion
function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        // Create a proper Pacific timezone date
        const pacificDateTime = `${pacificDateStr}T${pacificTimeStr}:00-07:00`; // Assume PDT for simplicity
        const utcDate = new Date(pacificDateTime);
        
        if (isNaN(utcDate.getTime())) {
            throw new Error('Invalid date created');
        }
        
        return utcDate.toISOString();
    } catch (error) {
        console.error('Error converting Pacific to UTC:', error.message);
        // Fallback: create UTC date directly
        return new Date(`${pacificDateStr}T${pacificTimeStr}:00.000Z`).toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const utcDate = new Date(utcDateStr);
        
        if (isNaN(utcDate.getTime())) {
            throw new Error('Invalid UTC date');
        }
        
        // Convert to Pacific time
        const pacificOptions = {
            timeZone: 'America/Vancouver',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        };
        
        const pacificTimeStr = utcDate.toLocaleTimeString('en-US', pacificOptions);
        return pacificTimeStr;
    } catch (error) {
        console.error('Error converting UTC to Pacific:', error.message);
        return '09:00';
    }
}

function getPacificDateRange(pacificDateStr) {
    try {
        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pacificDateStr)) {
            throw new Error('Invalid date format');
        }
        
        const startUTC = pacificTimeToUTC(pacificDateStr, '00:00');
        const endUTC = pacificTimeToUTC(pacificDateStr, '23:59');
        return { start: startUTC, end: endUTC };
    } catch (error) {
        console.error('Error getting Pacific date range:', error.message);
        // Fallback to UTC day range
        const fallbackStart = `${pacificDateStr}T00:00:00.000Z`;
        const fallbackEnd = `${pacificDateStr}T23:59:59.999Z`;
        return { start: fallbackStart, end: fallbackEnd };
    }
}

// FIXED: Simple work detection - if ANY events in work calendar, you're at site
async function getWorkShift(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, assuming home day');
        return { 
            isWorkDay: false, 
            isAtSite: false,
            startTime: '09:00', 
            endTime: '17:00', 
            title: 'Home Day',
            method: 'calendar-disabled'
        };
    }

    try {
        const dayRange = getPacificDateRange(today);
        
        console.log(`🔍 Checking work site calendar for ${today}...`);
        
        const workEvents = await calendar.events.list({
            calendarId: WORK_SITE_CALENDAR_ID,
            timeMin: dayRange.start,
            timeMax: dayRange.end,
            singleEvents: true,
            maxResults: 10
        });

        const hasWorkEvents = workEvents.data.items && workEvents.data.items.length > 0;
        
        if (hasWorkEvents) {
            console.log(`💼 Found ${workEvents.data.items.length} work site events - at site`);
            
            return {
                isWorkDay: true,
                isAtSite: true,
                startTime: '05:30',
                endTime: '17:30',
                title: 'Site Work Day',
                method: 'site-calendar-detected',
                events: workEvents.data.items.length
            };
        } else {
            console.log('🏠 No work site events found - home day');
            return {
                isWorkDay: false,
                isAtSite: false,
                startTime: '09:00',
                endTime: '17:00',
                title: 'Home Day',
                method: 'no-site-work'
            };
        }
        
    } catch (error) {
        console.error('⚠️ Error checking work site calendar:', error.message);
        
        return {
            isWorkDay: false,
            isAtSite: false,
            startTime: '09:00',
            endTime: '17:00',
            title: 'Home Day (Error)',
            method: 'error-fallback',
            error: error.message
        };
    }
}

// Import existing calendar events
async function importExistingCalendarEvents(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, skipping import');
        return [];
    }
    
    console.log('📥 Importing existing Google Calendar events...');
    
    const dayRange = getPacificDateRange(today);
    const importedEvents = [];
    let totalEvents = 0;
    let failedCalendars = [];
    
    for (const calendarId of ALL_CALENDAR_IDS) {
        try {
            console.log(`🔍 Scanning calendar: ${calendarId.substring(0, 20)}...`);
            
            const events = await calendar.events.list({
                calendarId: calendarId,
                timeMin: dayRange.start,
                timeMax: dayRange.end,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 50
            });
            
            if (events.data.items && events.data.items.length > 0) {
                console.log(`📅 Found ${events.data.items.length} events in this calendar`);
                
                for (const event of events.data.items) {
                    // Skip all-day events and events without times
                    if (!event.start?.dateTime || !event.end?.dateTime) {
                        console.log(`⏭️ Skipping all-day/untimed event: ${event.summary || 'Untitled'}`);
                        continue;
                    }
                    
                    // Convert to Pacific time for processing
                    const startPacific = utcToPacificTime(event.start.dateTime);
                    const endPacific = utcToPacificTime(event.end.dateTime);
                    
                    // Basic validation - reject suspicious times
                    const duration = getMinutesBetween(startPacific, endPacific);
                    if (duration <= 0 || duration > 12 * 60) {
                        console.log(`⚠️ Skipping event with invalid duration: ${event.summary} (${duration} min)`);
                        continue;
                    }
                    
                    const { type, context } = inferTypeAndContextFromCalendar(calendarId, event.summary || 'Imported Event');
                    
                    const importedEvent = {
                        title: event.summary || 'Imported Event',
                        startTime: startPacific,
                        endTime: endPacific,
                        duration: duration,
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
            }
            
        } catch (error) {
            if (error.code === 403) {
                console.log(`⚠️ No access to calendar ${calendarId.substring(0, 20)}, skipping`);
                failedCalendars.push(calendarId);
            } else {
                console.error(`⚠️ Error scanning calendar ${calendarId.substring(0, 20)}: ${error.message}`);
                failedCalendars.push(calendarId);
            }
        }
    }
    
    // Sort by start time
    importedEvents.sort((a, b) => {
        const aMinutes = parseInt(a.startTime.split(':')[0]) * 60 + parseInt(a.startTime.split(':')[1]);
        const bMinutes = parseInt(b.startTime.split(':')[0]) * 60 + parseInt(b.startTime.split(':')[1]);
        return aMinutes - bMinutes;
    });
    
    console.log(`📥 Import complete: ${totalEvents} events from ${ALL_CALENDAR_IDS.length} calendars (${failedCalendars.length} failed)`);
    return importedEvents;
}

// Infer type/context from calendar source
function inferTypeAndContextFromCalendar(calendarId, eventTitle) {
    const eventTitleLower = (eventTitle || '').toLowerCase();
    
    // Check each mapping to see which calendar this came from
    for (const [key, id] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
        if (id === calendarId) {
            const [context, type] = key.split('-');
            return { context, type };
        }
    }
    
    // Fallback logic
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
        return { context: 'Work', type: 'Events' };
    }
}

// Create imported events as time blocks
async function createImportedTimeBlocks(importedEvents, today) {
    console.log(`💾 Creating ${importedEvents.length} imported events in Notion...`);
    
    const created = [];
    const skipped = [];
    
    for (const event of importedEvents) {
        try {
            // Check if this event already exists
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
            
            // Store times as UTC in Notion
            const startUTC = pacificTimeToUTC(today, event.startTime);
            const endUTC = pacificTimeToUTC(today, event.endTime);
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Title: { title: [{ text: { content: event.title } }] },
                    Type: { select: { name: event.type } },
                    Context: { select: { name: event.context } },
                    'Energy Requirements': { select: { name: 'Medium' } },
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
                    'Auto-Filled': { checkbox: false },
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

// Get enhanced morning log data
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

// Calculate AI adjustments (same logic as before)
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
    
    // Body status impact
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
    
    // Stress level impact
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
    
    // Mood adjustments
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
    
    // Bounds checking to prevent extreme values
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
    
    // Compound state analysis
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

// Generate AI schedule around existing events
async function generateAIScheduleAroundFixedEvents(existingEvents, morningData, adjustedParams, workShift) {
    console.log(`🧠 Generating AI schedule around ${existingEvents.length} existing events...`);
    console.log(`📍 Work status: ${workShift.title} (At site: ${workShift.isAtSite})`);
    
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
    const endOfDay = workShift.isAtSite ? '20:00' : '22:00'; // Earlier end if at site
    
    // Morning routine
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
            
            const slotBlocks = generateBlocksForTimeSlot(
                slotStart, 
                slotEnd, 
                availableMinutes,
                adjustedParams,
                workShift,
                isRecoveryMode,
                isPeakState
            );
            
            aiGeneratedBlocks.push(...slotBlocks);
        }
        
        // Update currentTime to end of current event (if exists)
        if (i < sortedEvents.length) {
            currentTime = sortedEvents[i].endTime;
        }
    }
    
    console.log(`🧠 Generated ${aiGeneratedBlocks.length} AI-optimized time blocks`);
    return aiGeneratedBlocks;
}

// Generate blocks for a specific available time slot
function generateBlocksForTimeSlot(slotStart, slotEnd, availableMinutes, adjustedParams, workShift, isRecoveryMode, isPeakState) {
    const blocks = [];
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    
    let currentTime = slotStart;
    const currentHour = parseInt(slotStart.split(':')[0]);
    
    while (getMinutesBetween(currentTime, slotEnd) >= 30) {
        const remainingMinutes = getMinutesBetween(currentTime, slotEnd);
        if (remainingMinutes <= 0) break; // Safety check
        
        let blockType, blockTitle, blockContext, blockDuration, blockEnergy;
        
        // Intelligent block assignment based on state and time
        if (isRecoveryMode) {
            blockType = 'Admin';
            blockTitle = 'Light Recovery Tasks';
            blockContext = workShift.isAtSite ? 'Personal' : 'Personal';
            blockDuration = Math.min(30, maxBlockDuration, remainingMinutes);
            blockEnergy = 'Low';
            
        } else if (currentHour >= 5 && currentHour < 9 && adjustedParams.deepWorkCapacity >= 0.8) {
            // Peak morning hours with good capacity
            blockType = 'Deep Work';
            blockTitle = isPeakState ? 'Peak Performance Deep Work' : 'Morning Deep Work';
            blockContext = 'Work';
            blockDuration = Math.min(isPeakState ? 90 : maxBlockDuration, remainingMinutes);
            blockEnergy = 'High';
            
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
                blockContext = workShift.isAtSite ? 'Work' : 'Personal';
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
                blockContext = workShift.isAtSite ? 'Work' : 'Personal';
                blockDuration = Math.min(maxBlockDuration, remainingMinutes);
                blockEnergy = 'Medium';
            } else {
                blockType = 'Admin';
                blockTitle = 'Light Afternoon Tasks';
                blockContext = workShift.isAtSite ? 'Work' : 'Personal';
                blockDuration = Math.min(45, remainingMinutes);
                blockEnergy = 'Low';
            }
            
        } else if (currentHour >= 15 && currentHour < 17) {
            // FIXED: Only schedule Riley time if NOT at work site
            if (!workShift.isAtSite) {
                blockType = 'Events';
                blockTitle = 'Riley Time' + (currentHour >= 16 ? ' (After School)' : '');
                blockContext = 'Riley';
                blockDuration = Math.min(90, remainingMinutes);
                blockEnergy = 'Medium';
            } else {
                // At site: continue work tasks or personal time
                blockType = 'Admin';
                blockTitle = 'Site Work Tasks';
                blockContext = 'Work';
                blockDuration = Math.min(60, remainingMinutes);
                blockEnergy = 'Medium';
            }
            
        } else if (currentHour >= 17 && currentHour < 20) {
            // Evening hours
            if (!workShift.isAtSite) {
                blockType = 'Events';
                blockTitle = currentHour >= 18 ? 'Family Dinner Time' : 'Family Time';
                blockContext = 'Family';
                blockDuration = Math.min(90, remainingMinutes);
                blockEnergy = 'Low';
            } else {
                // At site: personal recovery time
                blockType = 'Events';
                blockTitle = 'Site Recovery Time';
                blockContext = 'Personal';
                blockDuration = Math.min(60, remainingMinutes);
                blockEnergy = 'Low';
            }
            
        } else {
            // Late evening
            blockType = 'Events';
            blockTitle = 'Personal Wind Down';
            blockContext = 'Personal';
            blockDuration = Math.min(60, remainingMinutes);
            blockEnergy = 'Low';
        }
        
        blocks.push({
            title: blockTitle,
            startTime: currentTime,
            duration: blockDuration,
            type: blockType,
            context: blockContext,
            energy: blockEnergy,
            rationale: `AI Generated: ${blockDuration}min ${blockType} for ${currentHour}:00 slot (Site: ${workShift.isAtSite})`
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
        
        // Add breaks if needed
        const remainingAfterBreak = getMinutesBetween(currentTime, slotEnd);
        if (blockDuration >= maxBlockDuration && remainingAfterBreak >= 30 && blockEnergy !== 'Low') {
            const breakDuration = isRecoveryMode ? 20 : 15;
            
            blocks.push({
                title: 'Energy Break',
                startTime: currentTime,
                duration: breakDuration,
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                rationale: `Adaptive break: ${breakDuration}min recovery`
            });
            
            currentTime = addMinutes(currentTime, breakDuration);
        }
    }
    
    return blocks;
}

// Create AI-generated time blocks in Notion
async function createAIGeneratedTimeBlocks(aiBlocks, today, dailyLogId) {
    console.log(`💾 Creating ${aiBlocks.length} AI-generated time blocks...`);
    
    const results = [];
    
    for (const [index, block] of aiBlocks.entries()) {
        try {
            const endTime = addMinutes(block.startTime, block.duration);
            const startUTC = pacificTimeToUTC(today, block.startTime);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            console.log(`📝 Creating AI block ${index + 1}/${aiBlocks.length}: ${block.title} (${block.startTime}-${endTime})`);
            
            // FIXED: Conditionally include Daily Logs relation
            const properties = {
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
                'Auto-Filled': { checkbox: true },
                Notes: { 
                    rich_text: [{ 
                        text: { 
                            content: `${block.rationale}\n\nType: ${block.type} | Context: ${block.context}\nEnergy: ${block.energy} | Duration: ${block.duration}min\n\nAI Enhanced Scheduling v2.0\nGenerated: ${new Date().toLocaleString()}`
                        } 
                    }] 
                }
            };
            
            // Only add Daily Logs relation if we have a valid ID
            if (dailyLogId) {
                properties['Daily Logs'] = { relation: [{ id: dailyLogId }] };
            }
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: properties
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
                gCalId: null,
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

// Export new blocks to Google Calendar
async function exportNewBlocksToCalendar(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar export disabled, skipping sync');
        return [];
    }
    
    console.log('📤 Exporting new time blocks to Google Calendar...');
    
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
            
            // Use exact key format that matches your mapping
            const routingKey = `${context}-${type}`;
            const calendarId = CONTEXT_TYPE_TO_CALENDAR_ID[routingKey] || "shamilarae@gmail.com";
            
            console.log(`📤 Exporting "${title}" to ${routingKey} -> ${calendarId.substring(0, 20)}...`);
            
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
            
            // Update Notion with GCal ID
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

// Clear auto-filled blocks
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
        for (const block of autoFilledBlocks.results) {
            try {
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
                cleared++;
            } catch (error) {
                console.error(`⚠️ Failed to clear block ${block.id}:`, error.message);
            }
        }

        console.log(`✅ Cleared ${cleared} AI blocks`);
        
    } catch (error) {
        console.error('⚠️ Error clearing auto-filled blocks:', error.message);
    }
}

// Main workflow orchestrator
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
        // Step 1: Clear existing AI blocks
        await clearAutoFilledBlocks(today);
        
        // Step 2: Import existing calendar events
        const importedEvents = await importExistingCalendarEvents(today);
        results.imported = await createImportedTimeBlocks(importedEvents, today);
        
        // Step 3: Get morning log and calculate adjustments
        results.morningData = await getEnhancedMorningLog(today);
        results.adjustedParams = calculateAdjustedParameters(results.morningData);
        
        // Step 4: Check work schedule
        results.workShift = await getWorkShift(today);
        
        // Step 5: Generate AI schedule around existing events
        const aiBlocks = await generateAIScheduleAroundFixedEvents(
            importedEvents, 
            results.morningData, 
            results.adjustedParams,
            results.workShift
        );
        
        // Step 6: Create AI blocks in Notion
        const dailyLogId = await getDailyLogId(today);
        results.aiGenerated = await createAIGeneratedTimeBlocks(aiBlocks, today, dailyLogId);
        
        // Step 7: Export new blocks to Google Calendar
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

// Display current schedule (convert stored UTC times back to Pacific for display)
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

                // Convert UTC times back to Pacific for display
                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                // Verify this is today's block by checking the Pacific date
                const utcStart = new Date(startTime);
                const pacificStart = new Date(utcStart.toLocaleString("en-US", {timeZone: "America/Vancouver"}));
                const pacificDateStr = pacificStart.toISOString().split('T')[0];
                
                if (pacificDateStr !== today) return null;

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: getTypeClass(type),
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

// Map type to original CSS classes for color scheme
function getTypeClass(type) {
    const typeMapping = {
        'Deep Work': 'deep-work',
        'Admin': 'admin',
        'Events': 'personal',
        'Meeting': 'meeting',
        'Routine': 'routine',
        'Appointment': 'meeting',
        'Travel': 'admin',
        'Break': 'break'
    };
    
    return typeMapping[type] || 'personal';
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
        console.log('🚀 UTC-First Bi-Directional Scheduler v2.2');
        
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

        if (action === 'create') {
            console.log('🔄 Running complete bi-directional sync...');
            
            const syncResults = await runBidirectionalSync(today);
            
            global.lastCreationResult = {
                success: syncResults.aiGenerated.filter(b => b.status === 'created').length,
                failed: syncResults.aiGenerated.filter(b => b.status === 'failed').length,
                imported: syncResults.imported.created.length,
                exported: syncResults.exported.filter(e => e.status === 'exported').length,
                adjustedParams: syncResults.adjustedParams,
                morningData: syncResults.morningData,
                workDay: syncResults.workShift.isWorkDay,
                isAtSite: syncResults.workShift.isAtSite,
                workShiftTitle: syncResults.workShift.title,
                optimizations: syncResults.adjustedParams ? Object.keys(syncResults.adjustedParams.optimizations).length : 0,
                calendarEnabled: calendarEnabled,
                errors: syncResults.errors,
                timestamp: new Date().toISOString()
            };
        }

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
                version: '2.2-UTC-First',
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
        
        console.error('❌ UTC-First Scheduler Error:', error.message);
        
        res.status(500).json({ 
            error: 'UTC-first scheduler failed',
            details: error.message,
            meta: {
                version: '2.2-UTC-First',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
}
