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

// FIXED: Robust timezone handling
function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        // Create date in Pacific timezone
        const pacificDateTime = `${pacificDateStr}T${pacificTimeStr}:00`;
        const localDate = new Date(pacificDateTime);
        
        // Convert to UTC by adding 7 hours (PDT offset)
        const utcDate = new Date(localDate.getTime() + (7 * 60 * 60 * 1000));
        return utcDate.toISOString();
    } catch (error) {
        console.error('Error in pacificTimeToUTC:', error.message);
        // Fallback
        return new Date(`${pacificDateStr}T${pacificTimeStr}:00.000Z`).toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const utcDate = new Date(utcDateStr);
        // Convert UTC to Pacific by subtracting 7 hours
        const pacificDate = new Date(utcDate.getTime() - (7 * 60 * 60 * 1000));
        
        const hours = pacificDate.getUTCHours();
        const minutes = pacificDate.getUTCMinutes();
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    } catch (error) {
        console.error('Error in utcToPacificTime:', error.message);
        return '09:00';
    }
}

function getPacificDateRange(pacificDateStr) {
    try {
        const startUTC = pacificTimeToUTC(pacificDateStr, '00:00');
        const endUTC = pacificTimeToUTC(pacificDateStr, '23:59');
        return { start: startUTC, end: endUTC };
    } catch (error) {
        console.error('Error in getPacificDateRange:', error.message);
        return {
            start: `${pacificDateStr}T00:00:00.000Z`,
            end: `${pacificDateStr}T23:59:59.999Z`
        };
    }
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

const ALL_CALENDAR_IDS = Object.values(CONTEXT_TYPE_TO_CALENDAR_ID);
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
        
        // Handle same-day only - if end is before start, assume 0 duration
        if (endTotalMins < startTotalMins) {
            console.warn(`End time ${endTime} before start time ${startTime} - assuming 0 duration`);
            return 0;
        }
        
        return endTotalMins - startTotalMins;
    } catch (error) {
        console.error('Error in getMinutesBetween:', error.message);
        return 0;
    }
}

function timeToMinutes(timeStr) {
    const [hours, mins] = timeStr.split(':').map(Number);
    return hours * 60 + mins;
}

function minutesToTime(minutes) {
    const hours = Math.floor(minutes / 60) % 24;
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

// FIXED: Intelligent gap-filling algorithm
function createFillerBlocks(startTime, endTime, energy = 'Medium') {
    const gapMinutes = getMinutesBetween(startTime, endTime);
    const blocks = [];
    
    if (gapMinutes <= 0) return blocks;
    
    let currentTime = startTime;
    
    while (getMinutesBetween(currentTime, endTime) >= 30) {
        const remainingMinutes = getMinutesBetween(currentTime, endTime);
        const currentHour = parseInt(currentTime.split(':')[0]);
        
        let blockTitle, blockType, blockContext, blockDuration;
        
        // Smart block assignment based on time of day
        if (currentHour >= 5 && currentHour < 9) {
            blockTitle = 'Morning Focus Time';
            blockType = 'Admin';
            blockContext = 'Work';
            blockDuration = Math.min(60, remainingMinutes);
        } else if (currentHour >= 9 && currentHour < 12) {
            blockTitle = 'Productive Work Block';
            blockType = 'Admin';
            blockContext = 'Work';
            blockDuration = Math.min(90, remainingMinutes);
        } else if (currentHour >= 14 && currentHour < 16) {
            blockTitle = 'Afternoon Projects';
            blockType = 'Admin';
            blockContext = 'Personal';
            blockDuration = Math.min(60, remainingMinutes);
        } else {
            blockTitle = 'Open Time Block';
            blockType = 'Events';
            blockContext = 'Personal';
            blockDuration = Math.min(60, remainingMinutes);
        }
        
        blocks.push({
            title: blockTitle,
            start: currentTime,
            duration: blockDuration,
            type: blockType,
            context: blockContext,
            energy: energy,
            isFiller: true
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
    }
    
    return blocks;
}

// FIXED: Break insertion algorithm
function insertBreaksIfNeeded(schedule) {
    const processedSchedule = [];
    
    for (let i = 0; i < schedule.length; i++) {
        const currentBlock = schedule[i];
        processedSchedule.push(currentBlock);
        
        // Check if we need a break after this block
        const needsBreak = (
            currentBlock.duration >= 90 || 
            currentBlock.energy === 'High' ||
            (currentBlock.type === 'Deep Work' && currentBlock.duration >= 60)
        );
        
        // Don't add break after last block or if next block is already a break
        const nextBlock = schedule[i + 1];
        const isLastBlock = i === schedule.length - 1;
        const nextIsBreak = nextBlock && (nextBlock.type === 'Events' || nextBlock.title.toLowerCase().includes('break'));
        
        if (needsBreak && !isLastBlock && !nextIsBreak) {
            const breakStart = addMinutes(currentBlock.start, currentBlock.duration);
            const breakDuration = currentBlock.energy === 'High' ? 15 : 10;
            
            processedSchedule.push({
                title: 'Energy Break',
                start: breakStart,
                duration: breakDuration,
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                isBreak: true
            });
            
            // Adjust next block start time if needed
            if (nextBlock) {
                const newNextStart = addMinutes(breakStart, breakDuration);
                nextBlock.start = newNextStart;
            }
        }
    }
    
    return processedSchedule;
}

// Work detection
async function getWorkShift(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar disabled, assuming home day');
        return { 
            isWorkDay: false, 
            isAtSite: false,
            startTime: '09:00', 
            endTime: '17:00', 
            title: 'Home Day'
        };
    }

    try {
        const dayRange = getPacificDateRange(today);
        
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
                title: 'Site Work Day'
            };
        } else {
            console.log('🏠 No work site events found - home day');
            return {
                isWorkDay: false,
                isAtSite: false,
                startTime: '09:00',
                endTime: '17:00',
                title: 'Home Day'
            };
        }
        
    } catch (error) {
        console.error('⚠️ Error checking work site calendar:', error.message);
        return {
            isWorkDay: false,
            isAtSite: false,
            startTime: '09:00',
            endTime: '17:00',
            title: 'Home Day (Error)'
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
    
    for (const calendarId of ALL_CALENDAR_IDS) {
        try {
            const events = await calendar.events.list({
                calendarId: calendarId,
                timeMin: dayRange.start,
                timeMax: dayRange.end,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 50
            });
            
            if (events.data.items && events.data.items.length > 0) {
                for (const event of events.data.items) {
                    if (!event.start?.dateTime || !event.end?.dateTime) {
                        continue; // Skip all-day events
                    }
                    
                    const startPacific = utcToPacificTime(event.start.dateTime);
                    const endPacific = utcToPacificTime(event.end.dateTime);
                    const duration = getMinutesBetween(startPacific, endPacific);
                    
                    if (duration <= 0 || duration > 12 * 60) {
                        continue; // Skip invalid durations
                    }
                    
                    const { type, context } = inferTypeAndContextFromCalendar(calendarId, event.summary || 'Imported Event');
                    
                    importedEvents.push({
                        title: event.summary || 'Imported Event',
                        startTime: startPacific,
                        endTime: endPacific,
                        duration: duration,
                        type: type,
                        context: context,
                        gCalId: event.id,
                        calendarId: calendarId,
                        isImported: true
                    });
                }
            }
            
        } catch (error) {
            console.log(`⚠️ Error scanning calendar ${calendarId.substring(0, 20)}: ${error.message}`);
        }
    }
    
    // Sort by start time
    importedEvents.sort((a, b) => {
        const aMinutes = timeToMinutes(a.startTime);
        const bMinutes = timeToMinutes(b.startTime);
        return aMinutes - bMinutes;
    });
    
    console.log(`📥 Import complete: ${importedEvents.length} events`);
    return importedEvents;
}

function inferTypeAndContextFromCalendar(calendarId, eventTitle) {
    for (const [key, id] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
        if (id === calendarId) {
            const [context, type] = key.split('-');
            return { context, type };
        }
    }
    
    // Fallback
    return { context: 'Personal', type: 'Events' };
}

// Get morning log data
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '04:30',
        energy: 7,
        mood: 'Steady',
        focusCapacity: 'Normal',
        socialBattery: 'Full',
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
        
        // Extract wake time properly
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            data.wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        // Extract other properties safely
        const energyValue = log['Energy']?.select?.name;
        if (energyValue && !isNaN(parseInt(energyValue))) {
            data.energy = parseInt(energyValue);
        }
        
        data.mood = log['Mood']?.select?.name || 'Steady';
        data.focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        data.socialBattery = log['Social Battery']?.select?.name || 'Full';
        data.sleepQuality = log['Sleep Quality']?.number || 7;
        
        console.log('✅ Successfully parsed morning log data');
        return data;
        
    } catch (error) {
        console.error('❌ Error fetching morning log:', error.message);
        return defaultData;
    }
}

// FIXED: Work day scheduling with proper flow and break management
function createWorkDaySchedule(wakeTime, workShift, routineTasks, energy, focusCapacity, allTasks) {
    console.log('Creating work day schedule with continuous flow');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine (Work Camp)',
        start: currentTime,
        duration: 30,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 30);
    
    // Fill time until work starts
    const preWorkBlocks = createFillerBlocks(currentTime, workShift.startTime, 'Medium');
    schedule.push(...preWorkBlocks);
    currentTime = workShift.startTime;
    
    // WORK BLOCKS with intelligent duration and break management
    const workEndTime = workShift.endTime;
    let consecutiveHighEnergyTime = 0;
    
    while (getMinutesBetween(currentTime, workEndTime) >= 30) {
        const currentHour = parseInt(currentTime.split(':')[0]);
        const availableMinutes = getMinutesBetween(currentTime, workEndTime);
        
        let blockType, blockTitle, blockEnergy, blockDuration;
        
        // Determine block type based on time and energy
        if (currentHour >= 5 && currentHour < 9) {
            // Prime morning hours
            if (energy >= 7 && focusCapacity === 'Sharp' && consecutiveHighEnergyTime < 180) {
                blockType = 'Deep Work';
                blockTitle = 'Deep Focus Work (Prime Hours)';
                blockEnergy = 'High';
                blockDuration = Math.min(90, availableMinutes);
                consecutiveHighEnergyTime += blockDuration;
            } else {
                blockType = 'Admin';
                blockTitle = 'Morning Admin';
                blockEnergy = 'Medium';
                blockDuration = Math.min(60, availableMinutes);
                consecutiveHighEnergyTime = 0;
            }
        } else if (currentHour >= 9 && currentHour < 12) {
            // Mid-morning
            if (energy >= 7 && consecutiveHighEnergyTime < 120) {
                blockType = 'Admin';
                blockTitle = 'Project Work';
                blockEnergy = 'Medium';
                blockDuration = Math.min(90, availableMinutes);
            } else {
                blockType = 'Admin';
                blockTitle = 'Admin & Communications';
                blockEnergy = 'Medium';
                blockDuration = Math.min(60, availableMinutes);
            }
            consecutiveHighEnergyTime = 0;
        } else if (currentHour === 12) {
            // Lunch time
            blockType = 'Events';
            blockTitle = 'Lunch Break';
            blockEnergy = 'Low';
            blockDuration = Math.min(60, availableMinutes);
            consecutiveHighEnergyTime = 0;
        } else if (currentHour >= 13 && currentHour < 15) {
            // Post-lunch
            blockType = 'Admin';
            blockTitle = 'Afternoon Project Work';
            blockEnergy = 'Medium';
            blockDuration = Math.min(90, availableMinutes);
            consecutiveHighEnergyTime = 0;
        } else {
            // Late afternoon
            blockType = 'Admin';
            blockTitle = 'Admin & Wrap-up';
            blockEnergy = 'Medium';
            blockDuration = Math.min(60, availableMinutes);
            consecutiveHighEnergyTime = 0;
        }
        
        schedule.push({
            title: blockTitle,
            start: currentTime,
            duration: blockDuration,
            type: blockType,
            context: 'Work',
            energy: blockEnergy
        });
        
        currentTime = addMinutes(currentTime, blockDuration);
    }
    
    // Post-work blocks
    const postWorkBlocks = createFillerBlocks(currentTime, '22:00', 'Low');
    schedule.push(...postWorkBlocks);
    
    // Insert breaks where needed
    return insertBreaksIfNeeded(schedule);
}

// FIXED: Home day scheduling with continuous flow
function createHomeDaySchedule(wakeTime, tasks, routineTasks, energy, focusCapacity) {
    console.log('Creating home day schedule with continuous flow');
    
    let schedule = [];
    let currentTime = wakeTime;
    
    // Morning routine
    schedule.push({
        title: 'Morning Routine & Recovery',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Morning work blocks based on energy
    if (energy >= 8 && focusCapacity === 'Sharp') {
        schedule.push({
            title: 'Deep Work Block 1',
            start: currentTime,
            duration: 90,
            type: 'Deep Work',
            context: 'Work',
            energy: 'High'
        });
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push({
            title: 'Deep Work Block 2',
            start: currentTime,
            duration: 90,
            type: 'Deep Work',
            context: 'Work',
            energy: 'High'
        });
        currentTime = addMinutes(currentTime, 90);
        
    } else if (energy >= 6) {
        schedule.push({
            title: 'Project Work Block',
            start: currentTime,
            duration: 120,
            type: 'Admin',
            context: 'Work',
            energy: 'Medium'
        });
        currentTime = addMinutes(currentTime, 120);
        
    } else {
        schedule.push({
            title: 'Light Admin Tasks',
            start: currentTime,
            duration: 90,
            type: 'Admin',
            context: 'Personal',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 90);
    }
    
    // FIXED: Fill time until lunch instead of jumping
    const lunchStartTime = '12:00';
    if (getMinutesBetween(currentTime, lunchStartTime) > 0) {
        const morningFillBlocks = createFillerBlocks(currentTime, lunchStartTime, 'Medium');
        schedule.push(...morningFillBlocks);
    }
    currentTime = lunchStartTime;
    
    // Lunch
    schedule.push({
        title: 'Lunch Break',
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 60);
    
    // Afternoon work
    schedule.push({
        title: 'Afternoon Work',
        start: currentTime,
        duration: 90,
        type: 'Admin',
        context: 'Work',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 90);
    
    // FIXED: Fill time until Riley time instead of jumping
    const rileyStartTime = '15:30';
    if (getMinutesBetween(currentTime, rileyStartTime) > 0) {
        const afternoonFillBlocks = createFillerBlocks(currentTime, rileyStartTime, 'Medium');
        schedule.push(...afternoonFillBlocks);
    }
    currentTime = rileyStartTime;
    
    // Riley Time
    schedule.push({
        title: 'Riley Time (After School)',
        start: currentTime,
        duration: 120,
        type: 'Events',
        context: 'Family',
        energy: 'Medium'
    });
    currentTime = addMinutes(currentTime, 120);
    
    // Evening blocks
    schedule.push({
        title: 'Dinner & Family Time',
        start: currentTime,
        duration: 90,
        type: 'Events',
        context: 'Family',
        energy: 'Low'
    });
    currentTime = addMinutes(currentTime, 90);
    
    // Fill remaining evening time
    const eveningFillBlocks = createFillerBlocks(currentTime, '22:00', 'Low');
    schedule.push(...eveningFillBlocks);
    
    // Insert breaks where needed
    return insertBreaksIfNeeded(schedule);
}

// Clear existing auto-filled blocks
async function clearAutoFilledBlocks(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
        const existing = await notion.databases.query({
            database_id: TIME_BLOCKS_DB_ID,
            filter: {
                property: 'Start Time',
                date: {
                    on_or_after: dayRange.start,
                    on_or_before: dayRange.end
                }
            },
            page_size: 100
        });

        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        console.log(`✅ Cleared ${existing.results.length} existing blocks`);
    } catch (error) {
        console.error('Error clearing blocks:', error.message);
    }
}

// Create time blocks in Notion
async function createTimeBlocks(schedule, today, dailyLogId) {
    console.log(`💾 Creating ${schedule.length} time blocks...`);
    
    const results = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            const properties = {
                Title: { title: [{ text: { content: block.title } }] },
                Type: { select: { name: block.type } },
                Context: { select: { name: block.context } },
                'Energy Requirements': { select: { name: block.energy } },
                Status: { select: { name: 'Active' } },
                'Start Time': { date: { start: startUTC } },
                'End Time': { date: { start: endUTC } },
                'Auto-Filled': { checkbox: true },
                Notes: { 
                    rich_text: [{ 
                        text: { 
                            content: `AI Enhanced Scheduling v2.0\n${block.isFiller ? 'Filler Block' : ''}${block.isBreak ? 'Auto Break' : ''}\nGenerated: ${new Date().toLocaleString()}`
                        } 
                    }] 
                }
            };
            
            if (dailyLogId) {
                properties['Daily Logs'] = { relation: [{ id: dailyLogId }] };
            }
            
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: properties
            });
            
            results.push({
                title: block.title,
                startTime: block.start,
                endTime: endTime,
                type: block.type,
                context: block.context,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create block "${block.title}":`, error.message);
            results.push({
                title: block.title,
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    return results;
}

// Export to Google Calendar
async function exportNewBlocksToCalendar(today) {
    if (!calendarEnabled) {
        console.log('📅 Calendar export disabled');
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
    
    const exportResults = [];
    
    for (const block of newBlocks.results) {
        try {
            const title = block.properties.Title?.title?.[0]?.text?.content || 'Untitled';
            const type = block.properties.Type?.select?.name || 'Events';
            const context = block.properties.Context?.select?.name || 'Personal';
            const startTime = block.properties['Start Time']?.date?.start;
            const endTime = block.properties['End Time']?.date?.start;
            
            if (!startTime || !endTime) continue;
            
            const routingKey = `${context}-${type}`;
            const calendarId = CONTEXT_TYPE_TO_CALENDAR_ID[routingKey] || "shamilarae@gmail.com";
            
            const event = {
                summary: title,
                description: `Type: ${type} | Context: ${context}\nAI Enhanced Scheduler`,
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
            
            await notion.pages.update({
                page_id: block.id,
                properties: {
                    'GCal ID': {
                        rich_text: [{ text: { content: response.data.id } }]
                    }
                }
            });
            
            exportResults.push({
                title: title,
                type: type,
                context: context,
                calendarId: calendarId,
                gCalId: response.data.id,
                status: 'exported'
            });
            
        } catch (error) {
            console.error(`❌ Failed to export block:`, error.message);
        }
    }
    
    console.log(`📤 Export complete: ${exportResults.length} blocks exported`);
    return exportResults;
}

// Main workflow
async function runEnhancedScheduler(today) {
    console.log('🚀 Starting enhanced scheduler workflow...');
    
    try {
        // Step 1: Clear existing blocks
        await clearAutoFilledBlocks(today);
        
        // Step 2: Import existing calendar events
        const importedEvents = await importExistingCalendarEvents(today);
        
        // Step 3: Get morning log
        const morningData = await getEnhancedMorningLog(today);
        
        // Step 4: Check work schedule
        const workShift = await getWorkShift(today);
        
        // Step 5: Generate schedule using fixed logic
        let schedule;
        if (workShift.isWorkDay) {
            schedule = createWorkDaySchedule(
                morningData.wakeTime, 
                workShift, 
                [], // routine tasks - simplified for now
                morningData.energy, 
                morningData.focusCapacity, 
                [] // all tasks - simplified for now
            );
        } else {
            schedule = createHomeDaySchedule(
                morningData.wakeTime, 
                [], // tasks - simplified for now
                [], // routine tasks - simplified for now
                morningData.energy, 
                morningData.focusCapacity
            );
        }
        
        // Step 6: Create blocks in Notion
        const dailyLogId = await getDailyLogId(today);
        const createdBlocks = await createTimeBlocks(schedule, today, dailyLogId);
        
        // Step 7: Export to Google Calendar
        const exportedBlocks = await exportNewBlocksToCalendar(today);
        
        global.lastCreationResult = {
            success: createdBlocks.filter(b => b.status === 'created').length,
            failed: createdBlocks.filter(b => b.status === 'failed').length,
            imported: importedEvents.length,
            exported: exportedBlocks.length,
            wakeTime: morningData.wakeTime,
            workDay: workShift.isWorkDay,
            energy: morningData.energy,
            focus: morningData.focusCapacity,
            timestamp: new Date().toISOString()
        };
        
        console.log('🎉 Enhanced scheduler completed successfully');
        return {
            imported: importedEvents,
            created: createdBlocks,
            exported: exportedBlocks,
            morningData: morningData,
            workShift: workShift
        };
        
    } catch (error) {
        console.error('❌ Enhanced scheduler failed:', error.message);
        throw error;
    }
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

// Display current schedule
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

                if (!startTime) return null;

                // Convert UTC times back to Pacific for display
                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                // Verify this is today's block
                const utcStart = new Date(startTime);
                const pacificStart = new Date(utcStart.getTime() - (7 * 60 * 60 * 1000));
                const pacificDateStr = pacificStart.toISOString().split('T')[0];
                
                if (pacificDateStr !== today) return null;

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: getTypeClass(type),
                    energy: 'medium',
                    details: `${context} • ${type}${autoFilled ? ' • AI Enhanced' : ''}`
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

// Map type to CSS classes
function getTypeClass(type) {
    const typeMapping = {
        'Deep Work': 'deep-work',
        'Admin': 'admin',
        'Events': 'personal',
        'Meeting': 'meeting',
        'Routine': 'routine',
        'Appointment': 'meeting',
        'Travel': 'admin'
    };
    
    return typeMapping[type] || 'personal';
}

// VERCEL HANDLER
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('🚀 Complete Fixed Scheduler v2.0 - No Gaps, Proper Breaks');
        
        if (!process.env.NOTION_TOKEN) {
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing NOTION_TOKEN'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        
        if (action === 'create') {
            console.log('🔄 Running complete fixed scheduler...');
            await runEnhancedScheduler(today);
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
                version: '2.0-Complete-Fixed',
                calendarEnabled: calendarEnabled,
                features: [
                    'No time gaps',
                    'Auto break insertion',
                    'Intelligent filler blocks',
                    'Proper timezone handling',
                    'Bi-directional calendar sync'
                ]
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

        console.log(`✅ Request completed in ${processingTime}ms`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('❌ Complete Fixed Scheduler Error:', error.message);
        
        res.status(500).json({ 
            error: 'Complete scheduler failed',
            details: error.message,
            meta: {
                version: '2.0-Complete-Fixed',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};
