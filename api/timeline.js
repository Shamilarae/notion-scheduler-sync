const { Client } = require('@notionhq/client');

// Initialize Notion client with error handling
let notion;
try {
    notion = new Client({
        auth: process.env.NOTION_TOKEN
    });
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

// Calendar routing with validation
const CALENDAR_ROUTING = {
    'deep work-work': '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com',
    'admin-work': 'ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com',
    'admin-personal': 'shamilarae@gmail.com',
    'meeting-work': '80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com',
    'events-riley': 'family13053487624784455294@group.calendar.google.com',
    'events-family': 'family13053487624784455294@group.calendar.google.com',
    'events-personal': 'shamilarae@gmail.com',
    'routine-personal': 'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com',
    'break-personal': 'shamilarae@gmail.com'
};

const WORK_SCHEDULE = {
    calendarId: 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
    startDate: '2025-08-28',
    endDate: '2025-09-10',
    dailyStart: '05:30',
    dailyEnd: '17:30'
};

// UTILITY FUNCTIONS (defined first to avoid dependency issues)
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
        return timeStr; // Return original time if parsing fails
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
        return endTotalMins - startTotalMins;
    } catch (error) {
        console.error('Error in getMinutesBetween:', error.message);
        return 0; // Return 0 if parsing fails
    }
}

// FIXED: Dynamic timezone handling instead of hardcoded offset
function getPacificOffset() {
    const now = new Date();
    const january = new Date(now.getFullYear(), 0, 1);
    const july = new Date(now.getFullYear(), 6, 1);
    const stdOffset = Math.max(january.getTimezoneOffset(), july.getTimezoneOffset());
    const currentOffset = now.getTimezoneOffset();
    
    // If current offset is different from standard, we're in DST
    const isDST = currentOffset < stdOffset;
    
    // Pacific is UTC-8 (PST) or UTC-7 (PDT)
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
        return new Date().toISOString(); // Fallback to current time
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
        return '09:00'; // Fallback to reasonable time
    }
}

function getPacificDateRange(pacificDateStr) {
    const pacificStartUTC = pacificTimeToUTC(pacificDateStr, '00:00');
    const pacificEndUTC = pacificTimeToUTC(pacificDateStr, '23:59');
    return { start: pacificStartUTC, end: pacificEndUTC };
}

// ENHANCED: Bulletproof morning log retrieval with comprehensive error handling
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
        const data = { ...defaultData }; // Start with defaults
        
        // SAFE: Extract each property with fallbacks
        try {
            const wakeTimeRaw = log['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                data.wakeTime = utcToPacificTime(wakeTimeRaw);
            }
        } catch (error) {
            console.error('Error parsing wake time:', error.message);
        }
        
        try {
            const energyValue = log['Energy']?.select?.name;
            if (energyValue && !isNaN(parseInt(energyValue))) {
                data.energy = parseInt(energyValue);
            }
        } catch (error) {
            console.error('Error parsing energy:', error.message);
        }
        
        // Safe extraction for all other properties
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
        console.log('📋 Using default morning data');
        return defaultData;
    }
}

// ENHANCED: Robust parameter calculation with bounds checking
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
    
    // SAFE: Validate input data
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
    
    // Body status impact with safe switch
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
        case 'Tired':
            adjustments.energyMultiplier *= 0.85;
            adjustments.focusMultiplier *= 0.9;
            adjustments.breakFrequencyMultiplier *= 1.2;
            adjustments.optimizations.body = "Physical fatigue: Increased breaks";
            break;
        case 'Strong':
            adjustments.energyMultiplier *= 1.15;
            adjustments.deepWorkCapacity *= 1.3;
            adjustments.blockDurationMultiplier *= 1.1;
            adjustments.optimizations.body = "Peak physical state: Enhanced capacity";
            break;
        default:
            // Normal or any unexpected value
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
    
    // Weather impact
    switch (morningData.weatherImpact) {
        case 'Draining':
            adjustments.energyMultiplier *= 0.85;
            adjustments.breakFrequencyMultiplier *= 1.3;
            adjustments.optimizations.weather = "Draining weather: Energy conservation mode";
            break;
        case 'Energizing':
            adjustments.energyMultiplier *= 1.15;
            adjustments.focusMultiplier *= 1.1;
            adjustments.optimizations.weather = "Energizing weather: Performance boost";
            break;
        case 'Cozy Vibes':
            adjustments.deepWorkCapacity *= 1.2;
            adjustments.focusMultiplier *= 1.1;
            adjustments.optimizations.weather = "Cozy conditions: Perfect for deep focus";
            break;
        default:
            adjustments.optimizations.weather = "Neutral weather: No adjustments";
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
        case 'Off Balance':
            adjustments.focusMultiplier *= 0.7;
            adjustments.blockDurationMultiplier *= 0.8;
            adjustments.socialToleranceMultiplier *= 0.6;
            adjustments.optimizations.mood = "Off balance: Flexible, low-pressure schedule";
            break;
        case 'Scattered':
            adjustments.focusMultiplier *= 0.6;
            adjustments.blockDurationMultiplier *= 0.7;
            adjustments.deepWorkCapacity *= 0.4;
            adjustments.optimizations.mood = "Scattered mood: Short, varied tasks";
            break;
        case 'Coasting':
            adjustments.energyMultiplier *= 0.9;
            adjustments.deepWorkCapacity *= 0.8;
            adjustments.optimizations.mood = "Coasting mood: Maintenance-level effort";
            break;
        default: // Steady or unknown
            adjustments.optimizations.mood = "Steady mood: Balanced approach";
    }
    
    // BOUNDS CHECKING: Prevent extreme values
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
    } else if (totalEnergyScore >= 7 && totalFocusScore >= 6) {
        adjustments.optimizations.compound = "⚡ GOOD STATE: Solid performance conditions";
    } else {
        adjustments.optimizations.compound = "📊 MIXED STATE: Some optimization needed";
    }
    
    return {
        ...adjustments,
        adjustedEnergy: Math.round(totalEnergyScore * 10) / 10,
        adjustedFocus: Math.round(totalFocusScore * 10) / 10,
        recommendedMaxBlockDuration: Math.round(Math.max(30, Math.min(120, 60 * adjustments.blockDurationMultiplier))),
        recommendedBreakInterval: Math.round(Math.max(45, Math.min(180, 90 / adjustments.breakFrequencyMultiplier)))
    };
}

// ENHANCED: Safe type and context mapping with validation
function getNotionTypeAndContext(blockType, blockTitle, currentHour) {
    const safeCurrentHour = Math.max(0, Math.min(23, currentHour || 9));
    let notionType, context;
    
    const blockTypeLower = (blockType || 'admin').toLowerCase().trim();
    const blockTitleLower = (blockTitle || '').toLowerCase();
    
    switch (blockTypeLower) {
        case 'deep work':
        case 'deep-work':
            notionType = 'Deep Work';
            context = 'Work';
            break;
        case 'creative':
            notionType = 'Deep Work'; // Creative maps to Deep Work type in your schema
            context = 'Work';
            break;
        case 'admin':
            notionType = 'Admin';
            // Context logic: work admin during business hours, personal admin evenings/weekends
            if (blockTitleLower.includes('work') || 
                blockTitleLower.includes('wrap-up') || 
                blockTitleLower.includes('business') ||
                (safeCurrentHour >= 8 && safeCurrentHour < 17)) {
                context = 'Work';
            } else {
                context = 'Personal';
            }
            break;
        case 'meeting':
            notionType = 'Meeting';
            context = blockTitleLower.includes('personal') || blockTitleLower.includes('family') ? 'Personal' : 'Work';
            break;
        case 'break':
            notionType = 'Break';
            context = 'Personal';
            break;
        case 'riley time':
        case 'riley-time':
            notionType = 'Events';
            context = 'Riley';
            break;
        case 'family':
            notionType = 'Events';
            context = 'Family';
            break;
        case 'personal':
            notionType = 'Events';
            context = 'Personal';
            break;
        case 'routine':
            notionType = 'Routine';
            context = blockTitleLower.includes('work') ? 'Work' : 'Personal';
            break;
        case 'work':
        case 'shift':
            notionType = 'Events';
            context = 'Work';
            break;
        case 'travel':
            notionType = 'Travel';
            context = 'Personal'; // Default to personal, could be work
            break;
        case 'appointment':
            notionType = 'Appointment';
            context = blockTitleLower.includes('work') || blockTitleLower.includes('business') ? 'Work' : 'Personal';
            break;
        default:
            console.log(`⚠️ Unknown block type: ${blockType}, using Events/Personal`);
            notionType = 'Events';
            context = 'Personal';
    }
    
    return { notionType, context };
}

// ENHANCED: Bulletproof Google Calendar event creation with detailed logging
async function createGoogleCalendarEvent(block, date, notionType, context) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, skipping event creation');
        return null;
    }
    
    try {
        const routingKey = `${notionType.toLowerCase().replace(/\s+/g, ' ')}-${context.toLowerCase()}`;
        const calendarId = CALENDAR_ROUTING[routingKey];
        
        if (!calendarId) {
            console.warn(`⚠️ No calendar mapping found for "${routingKey}", using personal calendar`);
            const fallbackCalendarId = 'shamilarae@gmail.com';
            
            const startTime = pacificTimeToUTC(date, block.start);
            const endTime = pacificTimeToUTC(date, addMinutes(block.start, block.duration));
            
            const event = {
                summary: `${block.title} [${notionType}]`,
                description: `Type: ${notionType}\nContext: ${context}\nEnergy: ${block.energy}\n\n${block.rationale || 'AI-optimized scheduling'}\n\n⚠️ Routed to personal calendar (no mapping found)\nCreated by Enhanced AI Scheduler`,
                start: { dateTime: startTime, timeZone: 'America/Vancouver' },
                end: { dateTime: endTime, timeZone: 'America/Vancouver' }
            };
            
            const response = await calendar.events.insert({
                calendarId: fallbackCalendarId,
                resource: event
            });
            
            console.log(`📅 Event created in fallback calendar: ${block.title}`);
            return { eventId: response.data.id, calendarId: fallbackCalendarId };
        }
        
        const startTime = pacificTimeToUTC(date, block.start);
        const endTime = pacificTimeToUTC(date, addMinutes(block.start, block.duration));
        
        const event = {
            summary: block.title,
            description: `Type: ${notionType} | Context: ${context}\nEnergy Level: ${block.energy}\n\n${block.rationale || 'AI-optimized scheduling'}\n\nEnhanced AI Scheduler v2.0`,
            start: { dateTime: startTime, timeZone: 'America/Vancouver' },
            end: { dateTime: endTime, timeZone: 'America/Vancouver' }
        };
        
        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event
        });
        
        console.log(`✅ Calendar event created: ${block.title} → ${calendarId.substring(0, 20)}...`);
        return { eventId: response.data.id, calendarId: calendarId };
        
    } catch (error) {
        console.error(`❌ Calendar event creation failed for "${block.title}":`, error.message);
        // Don't throw - just log and continue without calendar sync
        return null;
    }
}

// ENHANCED: Robust schedule creation with comprehensive error handling
async function createIntelligentSchedule(today) {
    console.log('🧠 Initializing enhanced intelligent scheduling system...');
    
    try {
        // Step 1: Get morning data with error handling
        console.log('📊 Analyzing morning state...');
        const morningData = await getEnhancedMorningLog(today);
        
        // Step 2: Calculate adjustments
        console.log('⚙️ Calculating AI adjustments...');
        const adjustedParams = calculateAdjustedParameters(morningData);
        
        console.log('📈 State Analysis Complete:', {
            energy: `${morningData.energy} → ${adjustedParams.adjustedEnergy}`,
            sleep: `${morningData.sleepHours}h (${morningData.sleepQuality}/10 quality)`,
            mood: morningData.mood,
            body: morningData.bodyStatus,
            stress: morningData.stressLevel,
            weather: morningData.weatherImpact,
            blockDuration: `${adjustedParams.recommendedMaxBlockDuration}min`,
            breakInterval: `${adjustedParams.recommendedBreakInterval}min`,
            deepWorkCapacity: `${Math.round(adjustedParams.deepWorkCapacity * 100)}%`,
            optimizations: Object.keys(adjustedParams.optimizations).length
        });
        
        // Step 3: Get tasks and work schedule
        console.log('📋 Fetching tasks and work schedule...');
        const [tasks, workShift] = await Promise.all([
            getTodaysTasks(today).catch(error => {
                console.error('⚠️ Tasks fetch failed:', error.message);
                return [];
            }),
            getWorkShift(today).catch(error => {
                console.error('⚠️ Work schedule check failed:', error.message);
                return { isWorkDay: false };
            })
        ]);
        
        console.log(`📅 Work Status: ${workShift.isWorkDay ? `${workShift.startTime}-${workShift.endTime}` : 'Home Day'}`);
        console.log(`📝 Tasks Found: ${tasks.length}`);
        
        // Step 4: Clear existing blocks
        console.log('🧹 Clearing existing time blocks...');
        await clearTodayBlocks(today);
        
        // Step 5: Generate optimized schedule
        console.log('🎯 Generating optimized schedule...');
        let schedule = [];
        
        if (workShift.isWorkDay) {
            schedule = createEnhancedWorkDaySchedule(morningData.wakeTime, workShift, tasks, adjustedParams);
        } else {
            schedule = createEnhancedHomeDaySchedule(morningData.wakeTime, tasks, adjustedParams);
        }
        
        console.log(`📊 Generated ${schedule.length} optimized time blocks`);
        
        // Step 6: Create time blocks in Notion and Google Calendar
        console.log('💾 Creating time blocks...');
        const results = await createTimeBlocks(schedule, today);
        
        // Step 7: Store results
        global.lastCreationResult = {
            success: results.filter(r => r.status === 'success').length,
            failed: results.filter(r => r.status === 'failed').length,
            failedBlocks: results.filter(r => r.status === 'failed'),
            adjustedParams: adjustedParams,
            morningData: morningData,
            workDay: workShift.isWorkDay,
            tasksCount: tasks.length,
            optimizations: Object.keys(adjustedParams.optimizations).length,
            calendarEnabled: calendarEnabled,
            timestamp: new Date().toISOString()
        };
        
        console.log(`✅ Schedule creation complete: ${results.filter(r => r.status === 'success').length} blocks created, ${results.filter(r => r.status === 'failed').length} failed`);
        
        // Log optimization summary
        console.log('🎯 AI Optimizations Applied:');
        Object.entries(adjustedParams.optimizations).forEach(([key, value]) => {
            console.log(`   ${key}: ${value}`);
        });
        
    } catch (error) {
        console.error('❌ Schedule creation failed:', error.message);
        global.lastCreationResult = {
            success: 0,
            failed: 1,
            error: error.message,
            timestamp: new Date().toISOString()
        };
        throw error;
    }
}

// ENHANCED: Safe time block creation with detailed error handling
async function createTimeBlocks(schedule, today) {
    const results = [];
    
    for (const [index, block] of schedule.entries()) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            const currentHour = parseInt(block.start.split(':')[0]) || 9;
            
            // Get proper Notion type and context
            const { notionType, context } = getNotionTypeAndContext(block.type, block.title, currentHour);
            
            // Convert Pacific times to UTC for storage
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            console.log(`📝 Creating block ${index + 1}/${schedule.length}: ${block.title} (${block.start}-${endTime})`);
            
            // Create the time block in Notion
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Name: { title: [{ text: { content: block.title } }] },
                    Type: { select: { name: notionType } },
                    Context: { select: { name: context } },
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
                                content: `${block.rationale || `Energy: ${block.energy}`}\n\nType: ${notionType} | Context: ${context}\nDuration: ${block.duration}min\nAI Enhanced Scheduling v2.0\n\nCreated: ${new Date().toLocaleString()}`
                            } 
                        }] 
                    }
                }
            });
            
            console.log(`✅ Notion block created: ${notionType}(${context})`);
            
            // Attempt Google Calendar sync (non-blocking)
            let calendarEventId = null;
            if (calendarEnabled) {
                try {
                    const calendarEvent = await createGoogleCalendarEvent(block, today, notionType, context);
                    if (calendarEvent) {
                        calendarEventId = calendarEvent.eventId;
                        
                        // Update Notion block with calendar ID
                        await notion.pages.update({
                            page_id: timeBlockResponse.id,
                            properties: {
                                'GCal ID': { 
                                    rich_text: [{ 
                                        text: { 
                                            content: calendarEvent.eventId 
                                        } 
                                    }] 
                                }
                            }
                        });
                        
                        console.log(`📅 Calendar sync successful`);
                    }
                } catch (calError) {
                    console.error(`⚠️ Calendar sync failed for ${block.title}:`, calError.message);
                    // Continue without calendar sync - don't fail the entire block
                }
            }
            
            results.push({
                title: block.title,
                type: notionType,
                context: context,
                time: `${block.start}-${endTime}`,
                duration: block.duration,
                rationale: block.rationale,
                notionId: timeBlockResponse.id,
                calendarId: calendarEventId,
                status: 'success'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create block "${block.title}":`, error.message);
            results.push({
                title: block.title,
                time: block.start,
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    return results;
}

// ENHANCED: Work day schedule with intelligent block sizing and break management
function createEnhancedWorkDaySchedule(wakeTime, workShift, tasks, adjustedParams) {
    console.log('🏢 Creating enhanced work day schedule...');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    const breakInterval = adjustedParams.recommendedBreakInterval;
    const isRecoveryMode = adjustedParams.optimizations.compound?.includes('RECOVERY MODE');
    const isPeakState = adjustedParams.optimizations.compound?.includes('PEAK STATE');
    
    // Adaptive pre-work routine
    const routineDuration = isRecoveryMode ? 60 : (adjustedParams.adjustedEnergy >= 7 ? 30 : 45);
    schedule.push({
        title: isRecoveryMode ? 'Gentle Morning Recovery' : 
               isPeakState ? 'Peak State Morning Prep' : 'Morning Routine (Work Prep)',
        start: currentTime,
        duration: routineDuration,
        type: 'Personal',
        energy: 'Low',
        rationale: `Adaptive routine: ${routineDuration}min based on state analysis`
    });
    currentTime = addMinutes(currentTime, routineDuration);
    
    // Pre-work productive time (if available)
    const preWorkAvailable = getMinutesBetween(currentTime, workShift.startTime);
    if (preWorkAvailable >= 30) {
        if (adjustedParams.deepWorkCapacity >= 0.8 && preWorkAvailable >= 60) {
            schedule.push({
                title: 'Pre-Work Deep Focus Session',
                start: currentTime,
                duration: Math.min(90, preWorkAvailable - 15), // Leave 15min buffer
                type: 'Deep Work',
                energy: 'High',
                rationale: 'High capacity detected: Utilizing pre-work peak hours'
            });
            currentTime = addMinutes(currentTime, Math.min(90, preWorkAvailable - 15));
        } else if (preWorkAvailable >= 45) {
            schedule.push({
                title: 'Pre-Work Admin & Planning',
                start: currentTime,
                duration: Math.min(45, preWorkAvailable - 15),
                type: 'Admin',
                energy: 'Medium',
                rationale: 'Productive pre-work preparation time'
            });
            currentTime = addMinutes(currentTime, Math.min(45, preWorkAvailable - 15));
        }
    }
    
    // Main work day blocks
    let workTime = workShift.startTime;
    const workEndTime = workShift.endTime;
    let lastBreakTime = workTime;
    let blockCount = 0;
    
    while (getMinutesBetween(workTime, workEndTime) >= 30) {
        const currentHour = parseInt(workTime.split(':')[0]);
        const timeSinceBreak = getMinutesBetween(lastBreakTime, workTime);
        const remainingWorkTime = getMinutesBetween(workTime, workEndTime);
        
        // Force break if needed
        if (timeSinceBreak >= breakInterval && workTime !== workShift.startTime && remainingWorkTime > 45) {
            const breakDuration = isRecoveryMode ? 20 : 15;
            schedule.push({
                title: isRecoveryMode ? 'Extended Recovery Break' : 
                       adjustedParams.adjustedEnergy < 5 ? 'Energy Restoration Break' : 'Focus Reset Break',
                start: workTime,
                duration: breakDuration,
                type: 'Break',
                energy: 'Low',
                rationale: `Adaptive break: ${breakDuration}min after ${timeSinceBreak}min of work`
            });
            workTime = addMinutes(workTime, breakDuration);
            lastBreakTime = workTime;
            continue;
        }
        
        let blockType, blockTitle, blockEnergy, blockDuration;
        
        // Intelligent block assignment based on comprehensive state
        if (isRecoveryMode || adjustedParams.deepWorkCapacity <= 0.3) {
            // Recovery/limited capacity mode
            blockType = 'Admin';
            blockTitle = 'Gentle Admin Tasks';
            blockEnergy = 'Low';
            blockDuration = Math.min(30, maxBlockDuration);
            
        } else if (currentHour >= 5 && currentHour < 9 && adjustedParams.deepWorkCapacity >= 0.8) {
            // Peak morning hours with good capacity
            blockType = 'Deep Work';
            blockTitle = isPeakState ? 'Peak Performance Deep Work' : 'Morning Deep Work Block';
            blockEnergy = adjustedParams.adjustedEnergy >= 8 ? 'High' : 'Medium';
            blockDuration = isPeakState ? Math.min(maxBlockDuration * 1.5, 90) : maxBlockDuration;
            
        } else if (currentHour >= 9 && currentHour < 12 && adjustedParams.adjustedFocus >= 7) {
            // Mid-morning with good focus
            if (adjustedParams.deepWorkCapacity >= 0.7) {
                blockType = adjustedParams.adjustedEnergy >= 8 ? 'Deep Work' : 'Creative';
                blockTitle = 'Mid-Morning Focus Block';
                blockEnergy = 'Medium';
                blockDuration = maxBlockDuration;
            } else {
                blockType = 'Admin';
                blockTitle = 'Morning Admin & Communications';
                blockEnergy = 'Medium';
                blockDuration = Math.min(maxBlockDuration, 45);
            }
            
        } else if (currentHour === 12) {
            // Lunch time
            const lunchDuration = isRecoveryMode ? 75 : 60;
            blockType = 'Break';
            blockTitle = isRecoveryMode ? 'Extended Lunch & Recovery' : 'Lunch Break';
            blockEnergy = 'Low';
            blockDuration = lunchDuration;
            lastBreakTime = addMinutes(workTime, lunchDuration);
            
        } else if (currentHour >= 13 && currentHour < 15) {
            // Post-lunch energy dip consideration
            if (adjustedParams.adjustedEnergy >= 7 && adjustedParams.deepWorkCapacity >= 0.6) {
                blockType = 'Creative';
                blockTitle = 'Post-Lunch Project Work';
                blockEnergy = 'Medium';
                blockDuration = maxBlockDuration;
            } else {
                blockType = 'Admin';
                blockTitle = 'Afternoon Admin Tasks';
                blockEnergy = adjustedParams.adjustedEnergy >= 6 ? 'Medium' : 'Low';
                blockDuration = Math.min(maxBlockDuration, 45);
            }
            
        } else {
            // Late afternoon wind-down
            blockType = 'Admin';
            blockTitle = currentHour >= 16 ? 'End-of-Day Wrap-up' : 'Afternoon Admin';
            blockEnergy = adjustedParams.adjustedEnergy >= 6 ? 'Medium' : 'Low';
            blockDuration = Math.min(maxBlockDuration, 45);
        }
        
        schedule.push({
            title: blockTitle,
            start: workTime,
            duration: blockDuration,
            type: blockType,
            energy: blockEnergy,
            rationale: `AI Block ${++blockCount}: ${blockDuration}min ${blockType.toLowerCase()} optimized for ${currentHour}:00 with ${adjustedParams.adjustedEnergy.toFixed(1)} energy`
        });
        
        workTime = addMinutes(workTime, blockDuration);
    }
    
    // Post-work recovery
    if (getMinutesBetween(workShift.endTime, '22:00') >= 60) {
        const recoveryDuration = isRecoveryMode ? 90 : (adjustedParams.adjustedEnergy < 5 ? 60 : 30);
        schedule.push({
            title: isRecoveryMode ? 'Deep Recovery & Restoration' : 'Post-Work Decompression',
            start: workShift.endTime,
            duration: recoveryDuration,
            type: 'Personal',
            energy: 'Low',
            rationale: `Post-work recovery: ${recoveryDuration}min based on daily stress load`
        });
    }
    
    console.log(`📊 Work schedule: ${schedule.length} blocks, ${blockCount} work blocks, ${schedule.filter(b => b.type === 'Break').length} breaks`);
    return schedule;
}

// ENHANCED: Home day schedule with intelligent capacity utilization
function createEnhancedHomeDaySchedule(wakeTime, tasks, adjustedParams) {
    console.log('🏠 Creating enhanced home day schedule...');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    const isRecoveryMode = adjustedParams.optimizations.compound?.includes('RECOVERY MODE');
    const isPeakState = adjustedParams.optimizations.compound?.includes('PEAK STATE');
    
    // Adaptive morning routine
    const routineDuration = isRecoveryMode ? 120 : (adjustedParams.adjustedEnergy < 5 ? 90 : 60);
    schedule.push({
        title: isRecoveryMode ? 'Extended Recovery & Self-Care' : 
               isPeakState ? 'Energized Morning Routine' : 'Morning Routine & Prep',
        start: currentTime,
        duration: routineDuration,
        type: 'Personal',
        energy: 'Low',
        rationale: `Adaptive morning: ${routineDuration}min routine based on comprehensive state analysis`
    });
    currentTime = addMinutes(currentTime, routineDuration);
    
    // Intelligent work block creation based on capacity
    if (isPeakState && adjustedParams.deepWorkCapacity >= 1.0) {
        // Peak state: Aggressive deep work scheduling
        schedule.push({
            title: 'Peak State Deep Work Session 1',
            start: currentTime,
            duration: Math.min(maxBlockDuration * 2, 120),
            type: 'Deep Work',
            energy: 'High',
            rationale: 'PEAK STATE: Extended deep work capability detected - maximizing output'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration * 2, 120));
        
        schedule.push({
            title: 'Active Recovery Break',
            start: currentTime,
            duration: 20,
            type: 'Break',
            energy: 'Low',
            rationale: 'Strategic break between intensive work sessions'
        });
        currentTime = addMinutes(currentTime, 20);
        
        schedule.push({
            title: 'Peak State Deep Work Session 2',
            start: currentTime,
            duration: Math.min(maxBlockDuration * 1.5, 90),
            type: 'Deep Work',
            energy: 'High',
            rationale: 'PEAK STATE: Second intensive work block while capacity remains high'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration * 1.5, 90));
        
    } else if (adjustedParams.deepWorkCapacity >= 0.6 && adjustedParams.adjustedEnergy >= 6) {
        // Good capacity: Standard productive scheduling
        const workBlockDuration = Math.min(maxBlockDuration * 1.2, 75);
        schedule.push({
            title: 'Focused Work Session',
            start: currentTime,
            duration: workBlockDuration,
            type: adjustedParams.adjustedFocus >= 7 ? 'Deep Work' : 'Creative',
            energy: adjustedParams.adjustedEnergy >= 7 ? 'Medium' : 'Low',
            rationale: `Moderate capacity: ${workBlockDuration}min work session adapted to current state`
        });
        currentTime = addMinutes(currentTime, workBlockDuration);
        
        schedule.push({
            title: 'Mid-Morning Break',
            start: currentTime,
            duration: 15,
            type: 'Break',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 15);
        
        schedule.push({
            title: 'Secondary Work Block',
            start: currentTime,
            duration: Math.min(maxBlockDuration, 60),
            type: 'Admin',
            energy: 'Medium',
            rationale: 'Follow-up work session with complementary task type'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration, 60));
        
    } else if (adjustedParams.deepWorkCapacity >= 0.3) {
        // Limited capacity: Gentle productive time
        schedule.push({
            title: 'Gentle Productive Time',
            start: currentTime,
            duration: Math.min(maxBlockDuration, 45),
            type: 'Admin',
            energy: 'Low',
            rationale: 'Limited capacity: Light administrative tasks only'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration, 45));
        
    } else {
        // Recovery mode: Minimal demands
        schedule.push({
            title: 'Light Organization & Self-Care',
            start: currentTime,
            duration: 30,
            type: 'Personal',
            energy: 'Low',
            rationale: 'RECOVERY MODE: Minimal demand activities only'
        });
        currentTime = addMinutes(currentTime, 30);
    }
    
    // Ensure we don't schedule past lunch time
    if (getMinutesBetween(currentTime, '12:00') < 0) {
        currentTime = '12:00';
    }
    
    // Adaptive lunch break
    const lunchDuration = isRecoveryMode ? 90 : (adjustedParams.adjustedEnergy < 5 ? 75 : 60);
    schedule.push({
        title: isRecoveryMode ? 'Extended Rest & Nourishment' : 'Lunch & Midday Break',
        start: currentTime,
        duration: lunchDuration,
        type: 'Break',
        energy: 'Low',
        rationale: `Adaptive lunch: ${lunchDuration}min for optimal midday recovery`
    });
    currentTime = addMinutes(currentTime, lunchDuration);
    
    // Afternoon activity based on remaining capacity
    const afternoonCapacity = adjustedParams.deepWorkCapacity * 0.8; // Reduced afternoon capacity
    if (afternoonCapacity >= 0.5) {
        schedule.push({
            title: 'Afternoon Project Time',
            start: currentTime,
            duration: Math.min(maxBlockDuration, 60),
            type: 'Creative',
            energy: 'Medium',
            rationale: 'Afternoon capacity sufficient for project work'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration, 60));
    } else {
        schedule.push({
            title: 'Gentle Afternoon Tasks',
            start: currentTime,
            duration: 45,
            type: 'Personal',
            energy: 'Low',
            rationale: 'Limited afternoon capacity: gentle activities only'
        });
        currentTime = addMinutes(currentTime, 45);
    }
    
    // Riley time (after school consideration)
    const rileyStartTime = Math.max(currentTime, '15:30') >= currentTime ? Math.max(currentTime, '15:30') : currentTime;
    schedule.push({
        title: 'Riley Time (After School)',
        start: rileyStartTime,
        duration: 120,
        type: 'Riley Time',
        energy: 'Medium',
        rationale: 'Dedicated family time - high priority'
    });
    currentTime = addMinutes(rileyStartTime, 120);
    
    // Evening wind-down
    schedule.push({
        title: 'Evening Family Time & Dinner',
        start: currentTime,
        duration: 90,
        type: 'Personal',
        energy: 'Low',
        rationale: 'Family connection and nourishment time'
    });
    currentTime = addMinutes(currentTime, 90);
    
    schedule.push({
        title: 'Personal Wind Down',
        start: currentTime,
        duration: 60,
        type: 'Personal',
        energy: 'Low',
        rationale: 'Evening recovery and sleep preparation'
    });
    
    console.log(`📊 Home schedule: ${schedule.length} blocks, capacity utilization: ${Math.round(adjustedParams.deepWorkCapacity * 100)}%`);
    return schedule;
}

// ENHANCED: Safe current schedule retrieval
async function getCurrentSchedule(today) {
    try {
        console.log(`📅 Fetching schedule for ${today}...`);
        
        const pacificDayRange = getPacificDateRange(today);
        
        const timeBlocks = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: pacificDayRange.start,
                    on_or_before: pacificDayRange.end
                }
            },
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 100
        });

        console.log(`📊 Found ${timeBlocks.results.length} blocks in database`);

        if (timeBlocks.results.length === 0) {
            return [];
        }

        const schedule = timeBlocks.results.map((block, index) => {
            try {
                const startTime = block.properties['Start Time']?.date?.start;
                const endTime = block.properties['End Time']?.date?.start;
                const title = block.properties['Name']?.title?.[0]?.text?.content || 'Untitled';
                const blockType = block.properties['Type']?.select?.name || 'Events';
                const context = block.properties['Context']?.select?.name || 'Personal';
                const autoFilled = block.properties['Auto-Filled']?.checkbox || false;

                if (!startTime) {
                    console.warn(`⚠️ Block ${index + 1} has no start time, skipping`);
                    return null;
                }

                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                // Verify this block is actually on the requested Pacific day
                const startUTC = new Date(startTime);
                const pacificStart = new Date(startUTC.getTime() + (getPacificOffset() * 60 * 60 * 1000));
                const pacificDateStr = pacificStart.toISOString().split('T')[0];
                
                if (pacificDateStr !== today) {
                    console.log(`📅 Block "${title}" is on ${pacificDateStr}, not ${today}, skipping`);
                    return null;
                }

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: blockType.toLowerCase().replace(/\s+/g, '-'),
                    energy: 'medium', // Default energy level for display
                    details: `${context} • ${blockType}${autoFilled ? ' • AI Enhanced' : ''}`
                };
            } catch (error) {
                console.error(`⚠️ Error processing block ${index + 1}:`, error.message);
                return null;
            }
        }).filter(block => block !== null);

        console.log(`✅ Successfully formatted ${schedule.length} blocks for display`);
        return schedule;

    } catch (error) {
        console.error('❌ Failed to get current schedule:', error.message);
        return [];
    }
}

// ENHANCED: Safe work shift detection
async function getWorkShift(today) {
    try {
        if (!calendarEnabled) {
            console.log('📅 Calendar disabled, checking date range for work status');
            const workStart = new Date(WORK_SCHEDULE.startDate);
            const workEnd = new Date(WORK_SCHEDULE.endDate);
            const checkDate = new Date(today);
            
            const isInWorkPeriod = checkDate >= workStart && checkDate <= workEnd;
            const isWeekday = checkDate.getDay() >= 1 && checkDate.getDay() <= 5;
            
            return {
                isWorkDay: isInWorkPeriod && isWeekday,
                startTime: WORK_SCHEDULE.dailyStart,
                endTime: WORK_SCHEDULE.dailyEnd,
                title: 'Work Shift (Date-based)',
                method: 'date-range'
            };
        }
        
        const workCalendarId = WORK_SCHEDULE.calendarId;
        const dayRange = getPacificDateRange(today);
        
        const events = await calendar.events.list({
            calendarId: workCalendarId,
            timeMin: dayRange.start,
            timeMax: dayRange.end,
            singleEvents: true,
            orderBy: 'startTime'
        });

        const hasWorkEvents = events.data.items && events.data.items.length > 0;
        
        return {
            isWorkDay: hasWorkEvents,
            startTime: WORK_SCHEDULE.dailyStart,
            endTime: WORK_SCHEDULE.dailyEnd,
            title: hasWorkEvents ? 'Work Shift' : 'Home Day',
            method: 'calendar-based',
            events: hasWorkEvents ? events.data.items.length : 0
        };
        
    } catch (error) {
        console.error('⚠️ Error checking work schedule:', error.message);
        
        // Fallback to date-based detection
        const workStart = new Date(WORK_SCHEDULE.startDate);
        const workEnd = new Date(WORK_SCHEDULE.endDate);
        const checkDate = new Date(today);
        
        const isInWorkPeriod = checkDate >= workStart && checkDate <= workEnd;
        const isWeekday = checkDate.getDay() >= 1 && checkDate.getDay() <= 5;
        
        return {
            isWorkDay: isInWorkPeriod && isWeekday,
            startTime: WORK_SCHEDULE.dailyStart,
            endTime: WORK_SCHEDULE.dailyEnd,
            title: 'Work Shift (Fallback)',
            method: 'fallback',
            error: error.message
        };
    }
}

// ENHANCED: Safe task retrieval
async function getTodaysTasks(today) {
    try {
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                and: [
                    {
                        or: [
                            { property: 'Due Date', date: { on_or_before: today } },
                            { property: 'Schedule Today?', checkbox: { equals: true } }
                        ]
                    },
                    { property: 'Status', select: { does_not_equal: 'Done' } }
                ]
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 50
        });

        return tasksResponse.results.map(task => {
            try {
                const props = task.properties;
                const title = props['Name']?.title?.[0]?.text?.content || 'Untitled Task';
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const due = props['Due Date']?.date?.start;
                const type = props['Type']?.select?.name || 'Admin';
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const autoSchedule = props['Auto-Schedule']?.checkbox || false;
                const fixedTime = props['Fixed Time']?.date?.start;
                
                const routine = priority === 'Routine' || type === 'Routine' || title.toLowerCase().includes('routine');
                
                return {
                    title,
                    priority,
                    due,
                    type: type.toLowerCase(),
                    routine,
                    estimatedTime: Math.max(15, Math.min(240, estimatedTime)), // Bound between 15min-4h
                    autoSchedule,
                    fixedTime,
                    id: task.id
                };
            } catch (error) {
                console.error('⚠️ Error parsing task:', error.message);
                return {
                    title: 'Task (parsing error)',
                    priority: 'Medium',
                    type: 'admin',
                    routine: false,
                    estimatedTime: 30,
                    autoSchedule: false
                };
            }
        });
        
    } catch (error) {
        console.error('⚠️ Error fetching tasks:', error.message);
        return [];
    }
}

// ENHANCED: Safe block clearing
async function clearTodayBlocks(today) {
    try {
        const pacificDayRange = getPacificDateRange(today);
        
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: pacificDayRange.start,
                    on_or_before: pacificDayRange.end
                }
            },
            page_size: 100
        });

        console.log(`🧹 Found ${existing.results.length} existing blocks to clear`);

        let cleared = 0;
        let failed = 0;

        for (const block of existing.results) {
            try {
                await notion.pages.update({
                    page_id: block.id,
                    archived: true
                });
                cleared++;
            } catch (error) {
                console.error(`⚠️ Failed to archive block ${block.id}:`, error.message);
                failed++;
            }
        }

        console.log(`✅ Cleared ${cleared} blocks, ${failed} failures`);
        
    } catch (error) {
        console.error('⚠️ Error clearing existing blocks:', error.message);
        // Continue anyway - don't fail schedule creation if cleanup fails
    }
}

// MAIN VERCEL HANDLER - Bulletproof with comprehensive error handling
export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('🚀 Enhanced Timeline API v2.0 - Request received');
        
        // Validate environment
        if (!process.env.NOTION_TOKEN) {
            console.error('❌ NOTION_TOKEN environment variable not set');
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing required environment variables',
                enhanced: true
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        const requestId = `req_${Date.now()}`;
        
        console.log(`📋 Request ${requestId}: action=${action}, date=${today}`);

        // Handle schedule creation
        if (action === 'create') {
            console.log('🧠 Initiating enhanced AI scheduling...');
            
            try {
                await createIntelligentSchedule(today);
                console.log('✅ Schedule creation completed successfully');
            } catch (scheduleError) {
                console.error('❌ Schedule creation failed:', scheduleError.message);
                
                // Return partial success response
                return res.status(500).json({
                    error: 'Schedule creation failed',
                    details: scheduleError.message,
                    fallback: 'Please check your morning log data and try again',
                    timestamp: new Date().toISOString(),
                    enhanced: true,
                    requestId: requestId
                });
            }
        }

        // Fetch current schedule
        console.log('📅 Fetching current schedule...');
        const schedule = await getCurrentSchedule(today);

        // Build comprehensive response
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
                version: '2.0-Enhanced',
                calendarEnabled: calendarEnabled,
                requestId: requestId
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

        // Add optimization summary if available
        if (global.lastCreationResult?.adjustedParams?.optimizations) {
            response.meta.optimizations = {
                count: Object.keys(global.lastCreationResult.adjustedParams.optimizations).length,
                applied: global.lastCreationResult.adjustedParams.optimizations
            };
        }

        // Add performance metrics
        response.meta.performance = {
            scheduleGeneration: action === 'create' ? 'completed' : 'skipped',
            dataRetrieval: schedule.length > 0 ? 'success' : 'empty',
            calendarSync: calendarEnabled ? 'enabled' : 'disabled',
            processingSpeed: processingTime < 3000 ? 'fast' : processingTime < 8000 ? 'normal' : 'slow'
        };

        console.log(`✅ Request ${requestId} completed in ${processingTime}ms`);
        console.log(`📊 Response: ${schedule.length} blocks, ${response.meta.optimizations?.count || 0} optimizations`);

        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('❌ Timeline API Error:', {
            message: error.message,
            stack: error.stack?.split('\n').slice(0, 3),
            processingTime: processingTime
        });
        
        // Comprehensive error response
        res.status(500).json({ 
            error: 'Enhanced Timeline API failure',
            details: error.message,
            troubleshooting: {
                commonCauses: [
                    'Missing or invalid NOTION_TOKEN',
                    'Database permissions insufficient',
                    'Network connectivity issues',
                    'Invalid morning log data structure'
                ],
                nextSteps: [
                    'Verify Notion integration permissions',
                    'Check morning log completion',
                    'Retry with ?action=display for read-only mode'
                ]
            },
            meta: {
                version: '2.0-Enhanced',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
}
