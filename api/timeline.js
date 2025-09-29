const { Client } = require('@notionhq/client');

// Initialize Notion client
let notion;
try {
    notion = new Client({ auth: process.env.NOTION_TOKEN });
} catch (error) {
    console.error('Failed to initialize Notion client:', error.message);
    throw new Error('NOTION_TOKEN is required');
}

// Database IDs - EXACT matches from your Notion
const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';

// Google Calendar setup
let calendar = null;
let calendarEnabled = false;

// Calendar routing configuration
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

// Initialize Google Calendar
try {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        const { google } = require('googleapis');
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });

        calendar = google.calendar({ version: 'v3', auth });
        calendarEnabled = true;
        console.log('Google Calendar integration enabled with 9 specialized calendars');
    } else {
        console.log('Google Calendar disabled: Missing credentials');
    }
} catch (error) {
    console.error('Google Calendar initialization failed:', error.message);
    console.log('Continuing with Notion-only scheduling');
}

// Timezone conversion functions
function pacificTimeToUTC(pacificDateStr, pacificTimeStr) {
    try {
        const pacificDateTime = `${pacificDateStr}T${pacificTimeStr}:00`;
        const tempDate = new Date(pacificDateTime);
        
        const pacificDate = new Date(tempDate.toLocaleString("en-US", {timeZone: "America/Vancouver"}));
        const utcDate = new Date(tempDate.toLocaleString("en-US", {timeZone: "UTC"}));
        const offset = utcDate.getTime() - pacificDate.getTime();
        
        return new Date(tempDate.getTime() + offset).toISOString();
    } catch (error) {
        console.error('Error in pacificTimeToUTC:', error.message);
        return new Date(`${pacificDateStr}T${pacificTimeStr}:00.000Z`).toISOString();
    }
}

function utcToPacificTime(utcDateStr) {
    try {
        const utcDate = new Date(utcDateStr);
        
        const pacificTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Vancouver',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(utcDate);
        
        return pacificTime;
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

// Utility functions
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

// STEP 1: CALENDAR SYNC IN (Existing Events → Time Blocks)
async function syncCalendarEventsToTimeBlocks(today) {
    const results = {
        imported: 0,
        updated: 0,
        errors: [],
        details: [],
        duplicatesSkipped: 0
    };

    if (!calendarEnabled) {
        console.log('Calendar sync disabled - skipping import');
        return results;
    }

    try {
        console.log('STEP 1: Syncing calendar events to Time Blocks...');
        const dayRange = getPacificDateRange(today);
        
        const processedEvents = new Set();
        
        for (const [contextType, calendarId] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
            try {
                const [context, type] = contextType.split('-');
                
                const eventsResponse = await calendar.events.list({
                    calendarId: calendarId,
                    timeMin: dayRange.start,
                    timeMax: dayRange.end,
                    singleEvents: true,
                    maxResults: 50,
                    showDeleted: false,
                    timeZone: 'America/Vancouver'
                });

                const events = eventsResponse.data.items || [];

                for (const event of events) {
                    try {
                        if (!event.start?.dateTime || !event.end?.dateTime) continue;

                        const eventStartUTC = new Date(event.start.dateTime);
                        const eventPacificDate = new Intl.DateTimeFormat('en-CA', {
                            timeZone: 'America/Vancouver',
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit'
                        }).format(eventStartUTC);

                        if (eventPacificDate !== today) continue;

                        const title = event.summary || 'Untitled Event';
                        const startTime = utcToPacificTime(event.start.dateTime);
                        const endTime = utcToPacificTime(event.end.dateTime);
                        
                        if (!startTime.match(/^\d{2}:\d{2}$/) || !endTime.match(/^\d{2}:\d{2}$/)) continue;
                        
                        const eventKey = `${title}|${startTime}|${endTime}`;
                        
                        if (processedEvents.has(eventKey)) {
                            results.duplicatesSkipped++;
                            continue;
                        }
                        
                        processedEvents.add(eventKey);
                        const gCalId = event.id;

                        const existingBlocks = await notion.databases.query({
                            database_id: TIME_BLOCKS_DB_ID,
                            filter: {
                                property: 'GCal ID',
                                rich_text: { equals: gCalId }
                            },
                            page_size: 1
                        });

                        const energyReq = inferEnergyFromType(type);
                        
                        const timeBlockData = {
                            Title: { title: [{ text: { content: title } }] },
                            Type: { select: { name: type } },
                            Context: { select: { name: context } },
                            'Start Time': { date: { start: event.start.dateTime } },
                            'End Time': { date: { start: event.end.dateTime } },
                            'Energy Requirements': { select: { name: energyReq } },
                            Status: { select: { name: 'Planned' } },
                            'GCal ID': { rich_text: [{ text: { content: gCalId } }] },
                            'Auto-Filled': { checkbox: false },
                            Notes: { 
                                rich_text: [{ 
                                    text: { 
                                        content: `Imported from ${contextType} calendar\n${event.description || ''}` 
                                    } 
                                }] 
                            }
                        };

                        if (existingBlocks.results.length > 0) {
                            await notion.pages.update({
                                page_id: existingBlocks.results[0].id,
                                properties: timeBlockData
                            });
                            results.updated++;
                        } else {
                            await notion.pages.create({
                                parent: { database_id: TIME_BLOCKS_DB_ID },
                                properties: timeBlockData
                            });
                            results.imported++;
                        }

                        results.details.push({
                            title,
                            context,
                            type,
                            time: `${startTime}-${endTime}`,
                            action: existingBlocks.results.length > 0 ? 'updated' : 'imported'
                        });

                    } catch (eventError) {
                        results.errors.push(`Failed to process event "${event.summary || 'Unknown'}": ${eventError.message}`);
                    }
                }

            } catch (calendarError) {
                results.errors.push(`Failed to sync calendar ${contextType}: ${calendarError.message}`);
            }
        }

        console.log(`Calendar sync complete: ${results.imported} imported, ${results.updated} updated, ${results.duplicatesSkipped} duplicates skipped, ${results.errors.length} errors`);
        return results;

    } catch (error) {
        console.error('Critical calendar sync error:', error.message);
        results.errors.push(`Critical calendar sync error: ${error.message}`);
        return results;
    }
}

function inferEnergyFromType(type) {
    const energyMap = {
        'Deep Work': 'High',
        'Meeting': 'Med',
        'Admin': 'Med',
        'Events': 'Low',
        'Appointment': 'Med',
        'Travel': 'Low',
        'Routine': 'Med'
    };
    return energyMap[type] || 'Med';
}

// STEP 2: MORNING LOG ANALYSIS
async function getEnhancedMorningLog(today) {
    const defaultData = {
        wakeTime: '06:00',
        energy: 7,
        mood: 'Steady',
        focusCapacity: 'Normal',
        socialBattery: 'Full',
        sleepQuality: 7,
        sleepHours: 7,
        bodyStatus: 'Normal',
        stressLevel: 'Normal',
        weatherImpact: 'None'
    };
    
    try {
        console.log('STEP 2: Analyzing morning log data...');
        const morningLogResponse = await notion.databases.query({
            database_id: DAILY_LOGS_DB_ID,
            filter: { property: 'Date', date: { equals: today } },
            page_size: 1
        });
        
        if (morningLogResponse.results.length === 0) {
            console.log('No morning log found for today, using defaults');
            return { ...defaultData, source: 'default' };
        }

        const log = morningLogResponse.results[0].properties;
        const data = { ...defaultData, source: 'morning_log' };
        
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            data.wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        const energyValue = log['Energy']?.select?.name;
        if (energyValue && !isNaN(parseInt(energyValue))) {
            data.energy = parseInt(energyValue);
        }
        
        data.mood = log['Mood']?.select?.name || 'Steady';
        data.focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        data.socialBattery = log['Social Battery']?.select?.name || 'Full';
        data.bodyStatus = log['Body Status']?.select?.name || 'Normal';
        data.stressLevel = log['Stress Level']?.select?.name || 'Normal';
        data.weatherImpact = log['Weather Impact']?.select?.name || 'None';
        
        data.sleepQuality = log['Sleep Quality']?.number || 7;
        data.sleepHours = log['Sleep Hours']?.number || 7;
        
        console.log('Morning log analysis complete:', {
            energy: data.energy,
            mood: data.mood,
            focus: data.focusCapacity,
            sleep: `${data.sleepHours}h (${data.sleepQuality}/10)`,
            stress: data.stressLevel
        });
        
        return data;
        
    } catch (error) {
        console.error('Error fetching morning log:', error.message);
        return { ...defaultData, source: 'error', error: error.message };
    }
}

// STEP 3: WORK SHIFT DETECTION
async function getWorkShift(today) {
    const homeDay = { 
        isWorkDay: false, 
        isAtSite: false,
        startTime: '09:00', 
        endTime: '17:00', 
        title: 'Home Day'
    };

    if (!calendarEnabled) {
        console.log('STEP 3: Calendar disabled, assuming home day');
        return homeDay;
    }

    try {
        console.log('STEP 3: Detecting work shift...');
        const dayRange = getPacificDateRange(today);
        
        const workEvents = await calendar.events.list({
            calendarId: CONTEXT_TYPE_TO_CALENDAR_ID['Work-Travel'],
            timeMin: dayRange.start,
            timeMax: dayRange.end,
            singleEvents: true,
            maxResults: 10
        });

        const hasWorkEvents = workEvents.data.items && workEvents.data.items.length > 0;
        
        if (hasWorkEvents) {
            console.log(`Found ${workEvents.data.items.length} work site events - at site`);
            return {
                isWorkDay: true,
                isAtSite: true,
                startTime: '05:30',
                endTime: '17:30',
                title: 'Site Work Day'
            };
        } else {
            console.log('No work site events found - home day');
            return homeDay;
        }
        
    } catch (error) {
        console.error('Error checking work shift:', error.message);
        return {
            ...homeDay,
            title: 'Home Day (Calendar Error)',
            error: error.message
        };
    }
}

// STEP 4: INTELLIGENT TASK COLLECTION & SELECTION
async function collectAndSelectTasks(today, morningData) {
    const results = {
        selectedTasks: [],
        deferredTasks: [],
        totalTasks: 0,
        errors: []
    };

    try {
        console.log('STEP 4: Collecting and selecting tasks...');
        
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                property: 'Status',
                select: { does_not_equal: 'Done' }
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 100
        });

        const allTasks = tasksResponse.results.map(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') return null;
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || '';
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                const carryover = props.Carryover?.checkbox || false;
                const status = props.Status?.select?.name;
                
                if (status === 'Done') return null;
                
                let urgency = 3;
                
                if (dueDate) {
                    const today = new Date();
                    const due = new Date(dueDate);
                    const daysUntilDue = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
                    
                    if (daysUntilDue < 0) urgency = 10;
                    else if (daysUntilDue === 0) urgency = 9;
                    else if (daysUntilDue === 1) urgency = 8;
                    else if (daysUntilDue <= 3 && priority === 'High') urgency = 7;
                    else if (daysUntilDue <= 7 && priority === 'High') urgency = 6;
                }
                
                if (priority === 'High' && !dueDate) urgency = 5;
                if (priority === 'Routine') urgency = 3;
                if (carryover) urgency += 1;
                
                let effort = 1;
                if (estimatedTime > 180) effort = 4;
                else if (estimatedTime > 90) effort = 3;
                else if (estimatedTime > 30) effort = 2;
                else effort = 1;
                
                return {
                    id: task.id,
                    title: title.trim(),
                    priority,
                    type: type || '',
                    estimatedTime: Math.max(30, estimatedTime || 30),
                    dueDate,
                    carryover,
                    urgency,
                    effort,
                    routine: priority === 'Routine',
                    used: false,
                    status: status
                };
                
            } catch (taskError) {
                results.errors.push(`Task processing error: ${taskError.message}`);
                return null;
            }
        }).filter(task => task !== null);

        results.totalTasks = allTasks.length;

        if (allTasks.length === 0) {
            console.warn('No active tasks found!');
            return results;
        }

        const isLowEnergy = morningData.energy <= 5;
        const availableHours = isLowEnergy ? 4 : 6;
        const availableMinutes = availableHours * 60;
        const bufferMinutes = availableMinutes * 0.2;
        const workingCapacity = availableMinutes - bufferMinutes;

        let usedCapacity = 0;
        
        for (const task of allTasks) {
            if (usedCapacity + task.estimatedTime <= workingCapacity) {
                results.selectedTasks.push(task);
                usedCapacity += task.estimatedTime;
                task.used = true;
            } else {
                results.deferredTasks.push(task);
            }
        }

        console.log(`Task selection complete: ${results.selectedTasks.length} selected, ${results.deferredTasks.length} deferred`);
        return results;

    } catch (error) {
        console.error('Task collection failed:', error.message);
        results.errors.push(`Task collection failed: ${error.message}`);
        return results;
    }
}

// STEP 5: INTELLIGENT SCHEDULE CREATION - COMPLETE WITH FULL EVENING COVERAGE
function createIntelligentSchedule(wakeTime, workShift, selectedTasks, morningData) {
    console.log('STEP 5: Creating intelligent schedule with full evening coverage...');
    
    const schedule = [];
    let currentTime = wakeTime;
    
    const isLowEnergy = morningData.energy <= 5;
    const isScatteredFocus = morningData.focusCapacity === 'Scattered';
    const isDrained = morningData.mood === 'Drained' || morningData.socialBattery === 'Drained';
    const isAchy = morningData.bodyStatus === 'Achy' || morningData.bodyStatus === 'Sick';
    const needsRecovery = morningData.sleepHours < 6;
    const isStressed = morningData.stressLevel === 'Maxed Out';
    const canDeepFocus = morningData.focusCapacity === 'Sharp' && morningData.energy >= 7;

    const blockDuration = isLowEnergy || isDrained || isAchy ? 45 : (canDeepFocus ? 90 : 60);
    const breakFrequency = isLowEnergy || isStressed ? 60 : 90;
    let consecutiveWorkMinutes = 0;

    const availableTasks = selectedTasks.map(t => ({...t, used: false}));
    
    function assignBestTask(blockType, phase = 'work') {
        const unusedTasks = availableTasks.filter(t => !t.used);
        if (unusedTasks.length === 0) return null;
        
        let selectedTask = null;
        
        if (phase === 'evening') {
            const personalTasks = unusedTasks.filter(t => t.type === 'Personal' || t.context === 'Personal');
            const highUrgencyTasks = unusedTasks.filter(t => t.urgency >= 7);
            
            selectedTask = personalTasks.length > 0 ? 
                personalTasks.sort((a, b) => b.urgency - a.urgency)[0] :
                highUrgencyTasks.length > 0 ?
                highUrgencyTasks.sort((a, b) => b.urgency - a.urgency)[0] :
                unusedTasks.sort((a, b) => b.urgency - a.urgency)[0];
        } else {
            if (blockType === 'Deep Work' && canDeepFocus) {
                selectedTask = unusedTasks.filter(t => t.urgency >= 6).sort((a, b) => b.urgency - a.urgency)[0] ||
                              unusedTasks.sort((a, b) => b.urgency - a.urgency)[0];
            } else if (blockType === 'Routine') {
                selectedTask = unusedTasks.filter(t => t.routine).sort((a, b) => a.urgency - b.urgency)[0] ||
                              unusedTasks.sort((a, b) => a.urgency - b.urgency)[0];
            } else {
                selectedTask = unusedTasks.sort((a, b) => b.urgency - a.urgency)[0];
            }
        }
        
        if (selectedTask) {
            selectedTask.used = true;
            console.log(`Assigned: "${selectedTask.title}" (Priority: ${selectedTask.priority}, Urgency: ${selectedTask.urgency}) to ${blockType} (${phase})`);
        }
        
        return selectedTask;
    }

    // Phase 1: Morning routine
    if (isLowEnergy || isDrained || needsRecovery) {
        schedule.push({
            title: 'Extended Morning Recovery',
            start: currentTime,
            duration: 90,
            type: 'Events',
            context: 'Personal',
            energy: 'Low',
            details: 'Coffee, gentle movement, ease into day'
        });
        currentTime = addMinutes(currentTime, 90);
        
        schedule.push({
            title: 'Light Admin & Check-ins',
            start: currentTime,
            duration: 30,
            type: 'Admin',
            context: 'Work',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes = 30;
    } else {
        const morningDuration = workShift.isAtSite ? 30 : 60;
        schedule.push({
            title: 'Morning Routine',
            start: currentTime,
            duration: morningDuration,
            type: 'Events',
            context: 'Personal',
            energy: 'Med'
        });
        currentTime = addMinutes(currentTime, morningDuration);
        
        schedule.push({
            title: 'Morning Planning & Priority Review',
            start: currentTime,
            duration: 30,
            type: 'Admin',
            context: 'Work',
            energy: 'Med'
        });
        currentTime = addMinutes(currentTime, 30);
        consecutiveWorkMinutes = 30;
    }

    // Phase 2: Main work blocks until lunch
    const lunchTime = '12:00';
    while (getMinutesBetween(currentTime, lunchTime) >= 30) {
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, lunchTime) >= 45) {
            const breakDuration = isLowEnergy || isDrained ? 20 : 15;
            const breakTitle = isDrained ? 'Recovery Break' : 'Energy Break';
            schedule.push({
                title: breakTitle,
                start: currentTime,
                duration: breakDuration,
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                details: isDrained ? 'Rest, hydrate, gentle movement' : 'Stretch, water, fresh air'
            });
            currentTime = addMinutes(currentTime, breakDuration);
            consecutiveWorkMinutes = 0;
        }

        let blockType, energyReq;
        
        const unusedTasks = availableTasks.filter(t => !t.used);
        const nextTask = unusedTasks.length > 0 ? unusedTasks.sort((a, b) => b.urgency - a.urgency)[0] : null;
        
        if (canDeepFocus && consecutiveWorkMinutes < 60 && nextTask && (nextTask.type === 'Deep Work' || nextTask.urgency >= 6)) {
            blockType = 'Deep Work';
            energyReq = 'High';
        } else if (nextTask && nextTask.routine) {
            blockType = 'Routine';
            energyReq = 'Med';
        } else if (nextTask && nextTask.type === 'Deep Work') {
            blockType = 'Deep Work';
            energyReq = isLowEnergy ? 'Med' : 'High';
        } else {
            blockType = 'Admin';
            energyReq = isLowEnergy ? 'Low' : 'Med';
        }

        const selectedTask = assignBestTask(blockType);
        const workDuration = Math.min(blockDuration, getMinutesBetween(currentTime, lunchTime));

        if (selectedTask) {
            let finalBlockType = blockType;
            let finalEnergyReq = energyReq;
            
            if (selectedTask.type === 'Deep Work') {
                finalBlockType = 'Deep Work';
                finalEnergyReq = isLowEnergy ? 'Med' : 'High';
            } else if (selectedTask.routine) {
                finalBlockType = 'Routine';
                finalEnergyReq = 'Med';
            } else if (selectedTask.type === 'Admin') {
                finalBlockType = 'Admin';
                finalEnergyReq = isLowEnergy ? 'Low' : 'Med';
            }
            
            schedule.push({
                title: selectedTask.title,
                start: currentTime,
                duration: Math.min(workDuration, selectedTask.estimatedTime),
                type: finalBlockType,
                context: 'Work',
                energy: finalEnergyReq,
                taskId: selectedTask.id,
                details: `Priority: ${selectedTask.priority}, Urgency: ${selectedTask.urgency}/10`
            });
        } else {
            const genericTitle = blockType === 'Deep Work' ? 'Deep Focus Session' : 
                               blockType === 'Routine' ? 'Routine Tasks' : 'Project Work';
            schedule.push({
                title: genericTitle,
                start: currentTime,
                duration: workDuration,
                type: blockType,
                context: 'Work',
                energy: energyReq
            });
        }

        currentTime = addMinutes(currentTime, workDuration);
        consecutiveWorkMinutes += workDuration;
    }

    // Phase 3: Lunch break
    currentTime = lunchTime;
    const lunchDuration = (isLowEnergy || needsRecovery || isDrained) ? 90 : 60;
    const lunchTitle = isLowEnergy ? 'Extended Lunch & Rest' : 'Lunch Break';
    schedule.push({
        title: lunchTitle,
        start: currentTime,
        duration: lunchDuration,
        type: 'Events',
        context: 'Personal',
        energy: 'Low',
        details: isLowEnergy ? 'Nourish, rest, recharge deeply' : 'Eat, brief walk, recharge'
    });
    currentTime = addMinutes(currentTime, lunchDuration);
    consecutiveWorkMinutes = 0;

    // Phase 4: Afternoon work blocks
    const afternoonEnd = workShift.isAtSite ? '16:00' : '15:30';
    while (getMinutesBetween(currentTime, afternoonEnd) >= 30) {
        if (consecutiveWorkMinutes >= breakFrequency && getMinutesBetween(currentTime, afternoonEnd) >= 45) {
            schedule.push({
                title: 'Afternoon Break',
                start: currentTime,
                duration: 15,
                type: 'Events',
                context: 'Personal',
                energy: 'Low'
            });
            currentTime = addMinutes(currentTime, 15);
            consecutiveWorkMinutes = 0;
        }

        const workDuration = Math.min(45, getMinutesBetween(currentTime, afternoonEnd));
        const remainingTask = assignBestTask('Admin');
        
        if (remainingTask) {
            let blockType = 'Admin';
            let energyReq = 'Med';
            
            if (remainingTask.type === 'Deep Work') {
                blockType = 'Deep Work';
                energyReq = 'Med';
            } else if (remainingTask.routine) {
                blockType = 'Routine';
                energyReq = 'Med';
            } else if (remainingTask.type === 'Admin') {
                blockType = 'Admin';
                energyReq = 'Med';
            }

            schedule.push({
                title: remainingTask.title,
                start: currentTime,
                duration: Math.min(workDuration, remainingTask.estimatedTime),
                type: blockType,
                context: 'Work',
                energy: energyReq,
                taskId: remainingTask.id,
                details: `Afternoon session - Priority: ${remainingTask.priority}, Urgency: ${remainingTask.urgency}/10`
            });
        } else {
            const unusedTaskCount = availableTasks.filter(t => !t.used).length;
            
            let genericTitle, genericDetails;
            if (unusedTaskCount > 0) {
                genericTitle = 'Task Review & Organization';
                genericDetails = `Review ${unusedTaskCount} remaining items and organize for tomorrow`;
            } else {
                genericTitle = 'Strategic Planning Session';
                genericDetails = 'Plan approach for future priorities and improvements';
            }
            
            schedule.push({
                title: genericTitle,
                start: currentTime,
                duration: workDuration,
                type: 'Admin',
                context: 'Work',
                energy: 'Med',
                details: genericDetails
            });
        }

        currentTime = addMinutes(currentTime, workDuration);
        consecutiveWorkMinutes += workDuration;
    }

    // Phase 5: Work wind-down (extends work day to proper end time)
    const windDownEnd = workShift.isAtSite ? '17:30' : '17:00';
    currentTime = afternoonEnd;

    schedule.push({
        title: 'Work Wind-down & Transition',
        start: currentTime,
        duration: getMinutesBetween(currentTime, windDownEnd),
        type: 'Admin',
        context: 'Work',
        energy: 'Low',
        details: 'Email cleanup, tomorrow prep, mental transition'
    });
    currentTime = windDownEnd;

    // Phase 6: Dinner & Personal Transition (17:30-19:00)
    const dinnerEnd = '19:00';
    const dinnerTitle = isLowEnergy || isDrained ? 'Extended Dinner & Recovery' : 'Dinner & Family Time';
    const dinnerDetails = isLowEnergy ? 'Nourish, rest, gentle conversation' : 'Cook, eat, connect with family';

    schedule.push({
        title: dinnerTitle,
        start: currentTime,
        duration: getMinutesBetween(currentTime, dinnerEnd),
        type: 'Events',
        context: 'Personal',
        energy: 'Low',
        details: dinnerDetails
    });
    currentTime = dinnerEnd;

    // Phase 7: Evening Projects & Personal Time (19:00-21:00)
    const eveningProjectEnd = '21:00';
    const eveningTask = assignBestTask('Evening Work', 'evening');

    if (eveningTask && !isDrained) {
        const projectDuration = Math.min(60, eveningTask.estimatedTime);
        
        schedule.push({
            title: eveningTask.title,
            start: currentTime,
            duration: projectDuration,
            type: eveningTask.type === 'Personal' ? 'Events' : 'Deep Work',
            context: 'Personal',
            energy: 'Med',
            taskId: eveningTask.id,
            details: `Evening focus session - ${eveningTask.priority} priority`
        });
        currentTime = addMinutes(currentTime, projectDuration);
        
        if (getMinutesBetween(currentTime, eveningProjectEnd) > 0) {
            schedule.push({
                title: 'Personal Relaxation & Hobbies',
                start: currentTime,
                duration: getMinutesBetween(currentTime, eveningProjectEnd),
                type: 'Events',
                context: 'Personal',
                energy: 'Low',
                details: 'Reading, creative projects, gentle activities'
            });
        }
    } else {
        const personalTitle = isDrained ? 'Recovery & Self-Care Time' : 'Personal Projects & Hobbies';
        const personalDetails = isDrained ? 
            'Rest, gentle activities, early prep for sleep' : 
            'Creative work, reading, learning, personal interests';
        
        schedule.push({
            title: personalTitle,
            start: currentTime,
            duration: getMinutesBetween(currentTime, eveningProjectEnd),
            type: 'Events',
            context: 'Personal',
            energy: 'Low',
            details: personalDetails
        });
    }
    currentTime = eveningProjectEnd;

    // Phase 8: Evening Wind-down (21:00-22:00)
    const windDownTitle = needsRecovery || isDrained ? 'Early Sleep Prep' : 'Evening Routine';
    const windDownDetails = needsRecovery ? 
        'Chamomile tea, dim lights, prep for early sleep' : 
        'Journal, plan tomorrow, prepare for rest';

    schedule.push({
        title: windDownTitle,
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low',
        details: windDownDetails
    });
    currentTime = addMinutes(currentTime, 60);

    // Phase 9: Final Personal Time (22:00-23:00)
    const finalPersonalTitle = needsRecovery ? 'Sleep Preparation' : 'Quiet Personal Time';
    const finalPersonalDetails = needsRecovery ? 
        'Reading, meditation, early sleep routine' : 
        'Light reading, reflection, prepare for sleep';

    schedule.push({
        title: finalPersonalTitle,
        start: currentTime,
        duration: 60,
        type: 'Events',
        context: 'Personal',
        energy: 'Low',
        details: finalPersonalDetails
    });

    const tasksScheduled = availableTasks.filter(t => t.used).length;
    const tasksUnused = availableTasks.filter(t => !t.used).length;
    const finalTime = addMinutes(currentTime, 60);
    
    console.log(`Extended schedule created: ${schedule.length} blocks, ${tasksScheduled}/${selectedTasks.length} tasks assigned, ${tasksUnused} unused`);
    console.log(`Schedule spans: ${schedule[0].start} to ${finalTime} (${wakeTime} to 23:00)`);
    
    if (tasksUnused > 0) {
        console.log('Unused tasks that could be scheduled tomorrow:', 
            availableTasks.filter(t => !t.used).map(t => `"${t.title}" (${t.priority})`));
    }

    return schedule;
}

// Clear existing auto-filled blocks
async function clearAutoFilledBlocks(today) {
    try {
        const dayRange = getPacificDateRange(today);
        
        const existing = await notion.databases.query({
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

        for (const block of existing.results) {
            await notion.pages.update({
                page_id: block.id,
                archived: true
            });
        }
        
        console.log(`Cleared ${existing.results.length} existing auto-filled blocks`);
    } catch (error) {
        console.error('Error clearing blocks:', error.message);
    }
}

// STEP 6: CREATE TIME BLOCKS IN NOTION
async function createTimeBlocksInNotion(schedule, today, dailyLogId) {
    console.log('STEP 6: Creating time blocks in Notion...');
    
    const results = [];
    const energyMapping = { 'Low': 'Low', 'Med': 'Med', 'High': 'High' };

    await clearAutoFilledBlocks(today);

    for (const block of schedule) {
        try {
            if (!block || !block.title || !block.start || !block.duration) {
                console.warn('Skipping invalid block:', block);
                continue;
            }
            
            const endTime = addMinutes(block.start, block.duration);
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            const mappedEnergy = energyMapping[block.energy] || 'Med';
            
            const properties = {
                Title: { title: [{ text: { content: block.title } }] },
                Type: { select: { name: block.type } },
                Context: { select: { name: block.context } },
                'Energy Requirements': { select: { name: mappedEnergy } },
                Status: { select: { name: 'Planned' } },
                'Start Time': { date: { start: startUTC } },
                'End Time': { date: { start: endUTC } },
                'Auto-Filled': { checkbox: true }
            };
            
            if (block.taskId && typeof block.taskId === 'string') {
                properties['Tasks'] = { relation: [{ id: block.taskId }] };
            }
            
            if (dailyLogId && typeof dailyLogId === 'string') {
                properties['Daily Logs'] = { relation: [{ id: dailyLogId }] };
            }

            if (block.details) {
                properties['Notes'] = { 
                    rich_text: [{ text: { content: block.details } }] 
                };
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
                energy: mappedEnergy,
                taskId: block.taskId || null,
                notionId: timeBlockResponse.id,
                status: 'created'
            });
            
        } catch (error) {
            console.error(`Failed to create block "${block?.title || 'Unknown'}":`, error.message);
            results.push({
                title: block?.title || 'Unknown Block',
                error: error.message,
                status: 'failed'
            });
        }
    }
    
    const successful = results.filter(r => r.status === 'created').length;
    const failed = results.filter(r => r.status === 'failed').length;
    console.log(`Time blocks created: ${successful} successful, ${failed} failed`);
    
    return results;
}

// STEP 7: CALENDAR SYNC OUT
async function syncTimeBlocksToCalendar(today) {
    const results = {
        created: 0,
        updated: 0,
        errors: []
    };

    if (!calendarEnabled) {
        console.log('STEP 7: Calendar sync disabled - skipping export');
        return results;
    }

    try {
        console.log('STEP 7: Syncing AI-generated time blocks to calendar...');
        
        const dayRange = getPacificDateRange(today);
        const timeBlocks = await notion.databases.query({
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
            sorts: [{ property: 'Start Time', direction: 'ascending' }],
            page_size: 100
        });

        for (const block of timeBlocks.results) {
            try {
                const props = block.properties;
                const title = props.Title?.title?.[0]?.text?.content || 'Untitled';
                const context = props.Context?.select?.name || 'Personal';
                const type = props.Type?.select?.name || 'Events';
                const startTime = props['Start Time']?.date?.start;
                const endTime = props['End Time']?.date?.start;
                const notes = props.Notes?.rich_text?.[0]?.text?.content || '';
                const existingGCalId = props['GCal ID']?.rich_text?.[0]?.text?.content;

                if (!startTime || !endTime) continue;

                const calendarKey = `${context}-${type}`;
                const calendarId = CONTEXT_TYPE_TO_CALENDAR_ID[calendarKey] || CONTEXT_TYPE_TO_CALENDAR_ID['Personal-Events'];

                const eventData = {
                    summary: title,
                    description: `${notes}\n\nAI-generated time block\nContext: ${context}\nType: ${type}`,
                    start: { 
                        dateTime: startTime, 
                        timeZone: 'America/Vancouver' 
                    },
                    end: { 
                        dateTime: endTime, 
                        timeZone: 'America/Vancouver' 
                    },
                    source: { 
                        title: 'Notion AI Scheduler', 
                        url: `https://notion.so/${block.id.replace(/-/g, '')}` 
                    }
                };

                let eventResult;
                if (existingGCalId) {
                    try {
                        eventResult = await calendar.events.update({
                            calendarId: calendarId,
                            eventId: existingGCalId,
                            resource: eventData
                        });
                        results.updated++;
                    } catch (updateError) {
                        if (updateError.code === 404) {
                            eventResult = await calendar.events.insert({
                                calendarId: calendarId,
                                resource: eventData
                            });
                            results.created++;
                        } else {
                            throw updateError;
                        }
                    }
                } else {
                    eventResult = await calendar.events.insert({
                        calendarId: calendarId,
                        resource: eventData
                    });
                    results.created++;
                }

                if (eventResult && eventResult.data.id) {
                    await notion.pages.update({
                        page_id: block.id,
                        properties: {
                            'GCal ID': { 
                                rich_text: [{ text: { content: eventResult.data.id } }] 
                            }
                        }
                    });
                }

            } catch (blockError) {
                results.errors.push(`Failed to sync block: ${blockError.message}`);
            }
        }

        console.log(`Calendar sync complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`);
        return results;

    } catch (error) {
        console.error('Critical calendar sync error:', error.message);
        results.errors.push(`Critical calendar sync error: ${error.message}`);
        return results;
    }
}

// Get daily log ID helper
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

// MAIN WORKFLOW
async function runEnhancedSchedulerWorkflow(today) {
    console.log('Starting Enhanced AI Scheduler Workflow...');
    
    const startTime = Date.now();
    const results = {
        success: true,
        steps: {},
        errors: [],
        summary: {}
    };

    try {
        console.log('\n📅 STEP 1: Calendar Sync In');
        results.steps.calendarSyncIn = await syncCalendarEventsToTimeBlocks(today);
        
        console.log('\n🌅 STEP 2: Morning Log Analysis');
        results.steps.morningLog = await getEnhancedMorningLog(today);
        
        console.log('\n🏢 STEP 3: Work Shift Detection');
        results.steps.workShift = await getWorkShift(today);
        
        console.log('\n📋 STEP 4: Task Collection & Selection');
        results.steps.tasks = await collectAndSelectTasks(today, results.steps.morningLog);
        
        console.log('\n🧠 STEP 5: Schedule Creation');
        results.steps.schedule = createIntelligentSchedule(
            results.steps.morningLog.wakeTime,
            results.steps.workShift,
            results.steps.tasks.selectedTasks,
            results.steps.morningLog
        );
        
        console.log('\n📝 STEP 6: Creating Time Blocks');
        const dailyLogId = await getDailyLogId(today);
        results.steps.timeBlocks = await createTimeBlocksInNotion(
            results.steps.schedule, 
            today, 
            dailyLogId
        );
        
        console.log('\n📤 STEP 7: Calendar Sync Out');
        results.steps.calendarSyncOut = await syncTimeBlocksToCalendar(today);
        
        const processingTime = Date.now() - startTime;
        results.summary = {
            processingTimeMs: processingTime,
            calendarImported: results.steps.calendarSyncIn.imported + results.steps.calendarSyncIn.updated,
            tasksConsidered: results.steps.tasks.totalTasks,
            tasksSelected: results.steps.tasks.selectedTasks.length,
            tasksDeferred: results.steps.tasks.deferredTasks.length,
            blocksCreated: results.steps.timeBlocks.filter(b => b.status === 'created').length,
            blocksToCalendar: results.steps.calendarSyncOut.created + results.steps.calendarSyncOut.updated,
            totalErrors: [
                ...results.steps.calendarSyncIn.errors,
                ...results.steps.tasks.errors,
                ...results.steps.calendarSyncOut.errors
            ].length,
            energyLevel: results.steps.morningLog.energy,
            workLocation: results.steps.workShift.isAtSite ? 'Site' : 'Home',
            adaptationsApplied: getAdaptationsApplied(results.steps.morningLog)
        };

        console.log('\n✅ SCHEDULER COMPLETE');
        console.log(`Processing time: ${Math.round(processingTime/1000 * 10)/10}s`);
        console.log(`Summary: ${results.summary.blocksCreated} blocks created, ${results.summary.tasksSelected}/${results.summary.tasksConsidered} tasks scheduled`);
        
        return results;

    } catch (error) {
        const processingTime = Date.now() - startTime;
        console.error('CRITICAL SCHEDULER FAILURE:', error.message);
        
        results.success = false;
        results.error = error.message;
        results.summary.processingTimeMs = processingTime;
        results.summary.totalErrors = 1;
        
        return results;
    }
}

function getAdaptationsApplied(morningData) {
    const adaptations = [];
    
    if (morningData.energy <= 5) adaptations.push('Low energy scheduling');
    if (morningData.focusCapacity === 'Scattered') adaptations.push('Reduced focus blocks');
    if (morningData.mood === 'Drained') adaptations.push('Extended recovery time');
    if (morningData.sleepHours < 6) adaptations.push('Sleep recovery protocol');
    if (morningData.stressLevel === 'Maxed Out') adaptations.push('Stress management breaks');
    if (morningData.bodyStatus === 'Achy') adaptations.push('Gentle activity blocks');
    
    return adaptations.length > 0 ? adaptations : ['Standard scheduling'];
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

        const schedule = timeBlocks.results.map(block => {
            try {
                const startTime = block.properties['Start Time']?.date?.start;
                const endTime = block.properties['End Time']?.date?.start;
                const title = block.properties.Title?.title?.[0]?.text?.content || 'Untitled';
                const type = block.properties.Type?.select?.name || 'Events';
                const context = block.properties.Context?.select?.name || 'Personal';
                const autoFilled = block.properties['Auto-Filled']?.checkbox || false;
                const hasTask = block.properties.Tasks?.relation?.length > 0;

                if (!startTime) return null;

                const pacificStartTime = utcToPacificTime(startTime);
                const pacificEndTime = endTime ? utcToPacificTime(endTime) : '';

                return {
                    time: pacificStartTime,
                    endTime: pacificEndTime,
                    title,
                    type: getTypeClass(type),
                    energy: 'medium',
                    details: `${context} • ${type}${hasTask ? ' • Task Assigned' : ''}${autoFilled ? ' • AI Enhanced' : ''}`
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

// Vercel handler
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const startTime = Date.now();
    
    try {
        console.log('Enhanced AI Scheduler v6.0 - Complete Evening Coverage');
        
        if (!process.env.NOTION_TOKEN) {
            return res.status(500).json({
                error: 'Server configuration error',
                details: 'Missing NOTION_TOKEN'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const action = req.query.action || 'display';
        
        console.log(`Processing request: action=${action}, date=${today}`);
        
        let workflowResults = null;
        if (action === 'create') {
            console.log('Running enhanced scheduler workflow with full evening coverage...');
            workflowResults = await runEnhancedSchedulerWorkflow(today);
        }

        const schedule = await getCurrentSchedule(today);
        const now = new Date();
        const processingTime = Date.now() - startTime;
        
        const response = {
            schedule: schedule,
            workflow: workflowResults,
            meta: {
                totalBlocks: schedule.length,
                creationAttempted: action === 'create',
                processingTimeMs: processingTime,
                timestamp: now.toISOString(),
                version: '6.0-Complete-Evening-Coverage',
                calendarEnabled: calendarEnabled,
                calendarsConfigured: Object.keys(CONTEXT_TYPE_TO_CALENDAR_ID).length,
                scheduleSpan: schedule.length > 0 ? 
                    `${schedule[0].time} to ${schedule[schedule.length-1].endTime || schedule[schedule.length-1].time}` : 
                    'No schedule found'
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

        console.log(`Enhanced request completed in ${processingTime}ms`);
        console.log(`Schedule coverage: ${response.meta.scheduleSpan}`);
        res.status(200).json(response);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        console.error('Enhanced Scheduler Error:', error.message);
        console.error('Error stack:', error.stack);
        
        res.status(500).json({ 
            error: 'Enhanced scheduler failed',
            details: error.message,
            stack: error.stack,
            meta: {
                version: '6.0-Complete-Evening-Coverage',
                processingTime: processingTime,
                timestamp: new Date().toISOString(),
                calendarEnabled: calendarEnabled
            }
        });
    }
};
