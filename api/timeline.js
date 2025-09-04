// Updated mapping functions to match your actual Notion database structure

// FIXED: Block type mapping to match your Google Calendar Schedule database
function getNotionTypeAndContext(blockType, blockTitle, currentHour) {
    let notionType, context;
    
    switch (blockType.toLowerCase()) {
        case 'deep work':
            notionType = 'Deep Work';  // Matches your Notion exactly
            context = 'Work';          // Work context for deep work blocks
            break;
            
        case 'creative':
            notionType = 'Deep Work';  // Creative work maps to Deep Work type
            context = 'Work';          // Work context for creative blocks
            break;
            
        case 'admin':
            notionType = 'Admin';      // Matches your Notion exactly
            // Context depends on the specific admin task
            if (blockTitle.includes('Work') || blockTitle.includes('Wrap-up') || currentHour < 17) {
                context = 'Work';
            } else {
                context = 'Personal';
            }
            break;
            
        case 'meeting':
            notionType = 'Meeting';    // Matches your Notion exactly
            context = 'Work';          // Most meetings are work context
            break;
            
        case 'break':
            notionType = 'Break';      // Matches your Notion exactly
            context = 'Personal';     // Breaks are personal time
            break;
            
        case 'riley time':
        case 'riley-time':
            notionType = 'Events';     // Riley time is an event
            context = 'Riley';         // Riley context
            break;
            
        case 'personal':
            notionType = 'Events';     // Personal activities are events
            context = 'Personal';     // Personal context
            break;
            
        case 'routine':
            notionType = 'Routine';    // Matches your Notion exactly
            context = 'Personal';     // Most routines are personal
            break;
            
        case 'work':
            notionType = 'Events';     // Work shifts are events
            context = 'Work';          // Work context
            break;
            
        default:
            notionType = 'Events';     // Default fallback
            context = 'Personal';     // Default context
    }
    
    return { notionType, context };
}

// UPDATED: Create time blocks with proper Notion properties
async function createTimeBlocks(schedule, today) {
    const createdBlocks = [];
    
    for (const block of schedule) {
        try {
            const endTime = addMinutes(block.start, block.duration);
            const currentHour = parseInt(block.start.split(':')[0]);
            
            // Get proper Notion type and context
            const { notionType, context } = getNotionTypeAndContext(block.type, block.title, currentHour);
            
            // Convert Pacific times to UTC for storage
            const startUTC = pacificTimeToUTC(today, block.start);
            const endUTC = pacificTimeToUTC(today, endTime);
            
            // Create the time block in Notion with correct properties
            const timeBlockResponse = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                properties: {
                    Name: { title: [{ text: { content: block.title } }] },
                    Type: { select: { name: notionType } },           // Using your actual Type options
                    Context: { select: { name: context } },           // Using your actual Context options
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
                    'Auto-Filled': { checkbox: true },                // Mark as auto-filled
                    Notes: { 
                        rich_text: [{ 
                            text: { 
                                content: `Energy: ${block.energy}\nAuto-created by AI Scheduler\n\nOriginal Type: ${block.type}`
                            } 
                        }] 
                    }
                }
            });
            
            console.log(`✅ Created: ${block.title} | Type: ${notionType} | Context: ${context} | ${block.start}-${endTime}`);
            
            // Create Google Calendar event with proper mapping
            try {
                const calendarEvent = await createGoogleCalendarEvent(block, today, notionType, context);
                if (calendarEvent) {
                    // Update the Notion block with the Google Calendar ID
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
                    
                    console.log(`📅 Calendar event created: ${calendarEvent.calendarId}`);
                }
            } catch (calError) {
                console.error(`❌ Calendar sync failed for ${block.title}:`, calError.message);
            }
            
            createdBlocks.push({
                title: block.title,
                type: notionType,
                context: context,
                time: `${block.start}-${endTime}`,
                status: 'success'
            });
            
        } catch (error) {
            console.error(`❌ Failed to create block "${block.title}":`, error.message);
            createdBlocks.push({
                title: block.title,
                status: 'failed',
                error: error.message
            });
        }
    }
    
    return createdBlocks;
}

// UPDATED: Calendar event creation with proper calendar routing
async function createGoogleCalendarEvent(block, date, notionType, context) {
    try {
        // Use the corrected mapping based on your actual Type and Context
        const calendarId = getCalendarIdForBlock(notionType, context);
        
        // Convert Pacific times to proper timezone for Google Calendar
        const startTime = pacificTimeToUTC(date, block.start);
        const endTime = pacificTimeToUTC(date, addMinutes(block.start, block.duration));
        
        const event = {
            summary: block.title,
            description: `Type: ${notionType}\nContext: ${context}\nEnergy: ${block.energy}\n\nAuto-created by AI Scheduler`,
            start: {
                dateTime: startTime,
                timeZone: 'America/Vancouver'
            },
            end: {
                dateTime: endTime,
                timeZone: 'America/Vancouver'
            },
            colorId: getEventColorId(notionType, context) // Optional: set colors based on type
        };
        
        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event
        });
        
        return {
            eventId: response.data.id,
            calendarId: calendarId
        };
        
    } catch (error) {
        console.error(`Calendar event creation failed for ${block.title}:`, error.message);
        throw error;
    }
}

// UPDATED: Calendar routing based on your actual Type/Context combinations
function getCalendarIdForBlock(notionType, context) {
    // Route based on Type + Context combination
    const routingKey = `${notionType.toLowerCase()}-${context.toLowerCase()}`;
    
    const CALENDAR_ROUTING = {
        // Deep Work blocks
        'deep work-work': '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com',
        
        // Admin blocks
        'admin-work': 'ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com',
        'admin-personal': 'shamilarae@gmail.com',
        
        // Meeting blocks
        'meeting-work': '80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com',
        'meeting-personal': 'shamilarae@gmail.com',
        
        // Riley time
        'events-riley': 'family13053487624784455294@group.calendar.google.com',
        
        // Family events
        'events-family': 'family13053487624784455294@group.calendar.google.com',
        
        // Personal events/activities
        'events-personal': 'shamilarae@gmail.com',
        
        // Work events
        'events-work': 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
        
        // Routine tasks
        'routine-personal': 'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com',
        'routine-work': 'ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com',
        
        // Breaks
        'break-personal': 'shamilarae@gmail.com',
        
        // Travel/Appointments
        'travel-personal': 'shamilarae@gmail.com',
        'travel-work': 'shamilarae@gmail.com',
        'appointment-personal': 'shamilarae@gmail.com',
        'appointment-work': 'shamilarae@gmail.com',
    };
    
    const calendarId = CALENDAR_ROUTING[routingKey] || 'shamilarae@gmail.com'; // Default to personal
    
    console.log(`🎯 Routing ${notionType}(${context}) -> ${calendarId.substring(0, 20)}...`);
    
    return calendarId;
}

// Optional: Set event colors based on type
function getEventColorId(notionType, context) {
    const colorMap = {
        'Deep Work': '9',     // Blue
        'Admin': '6',         // Orange  
        'Meeting': '2',       // Green
        'Break': '7',         // Cyan
        'Routine': '5',       // Yellow
        'Events': '10',       // Green
        'Travel': '4',        // Red
        'Appointment': '3'    // Purple
    };
    
    return colorMap[notionType] || '1'; // Default to blue
}

module.exports = {
    getNotionTypeAndContext,
    createTimeBlocks,
    createGoogleCalendarEvent,
    getCalendarIdForBlock,
    getEventColorId
};
