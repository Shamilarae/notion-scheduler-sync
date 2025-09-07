// CORRECTED: Get today's tasks with proper Notion API handling
async function getTodaysTasks(today) {
    try {
        if (!today || typeof today !== 'string') {
            console.error('Invalid today parameter:', today);
            return { flexibleTasks: [], fixedTimeTasks: [] };
        }
        
        console.log('Querying tasks database with CORRECTED filtering...');
        
        // Get ALL active tasks - filter logic comes AFTER retrieval
        const tasksResponse = await notion.databases.query({
            database_id: TASKS_DB_ID,
            filter: {
                and: [
                    {
                        property: 'Status',
                        select: { does_not_equal: 'Done' }
                    },
                    {
                        property: 'Done',
                        checkbox: { equals: false }
                    }
                ]
            },
            sorts: [
                { property: 'Priority Level', direction: 'ascending' },
                { property: 'Due Date', direction: 'ascending' }
            ],
            page_size: 100
        });

        console.log(`Found ${tasksResponse.results.length} total active tasks in database`);

        const flexibleTasks = [];
        const fixedTimeTasks = [];
        const todayDate = new Date(today);

        tasksResponse.results.forEach(task => {
            try {
                const props = task.properties;
                
                // CORRECTED: Proper Notion API property access
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn('Skipping task with empty title:', task.id);
                    return;
                }
                
                // CORRECTED: Handle select properties properly
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || 'Admin';
                const status = props.Status?.select?.name || 'To Do';
                
                // CORRECTED: Handle number properties
                const estimatedTime = props['Estimated Duration']?.number || 30;
                
                // CORRECTED: Handle date properties properly
                const dueDate = props['Due Date']?.date?.start;
                const fixedTime = props['Fixed Time']?.date?.start;
                
                // CORRECTED: Handle checkbox properties
                const scheduleToday = props['Schedule Today?']?.checkbox === true;
                const autoSchedule = props['Auto-Schedule']?.checkbox === true;
                const carryover = props['Carryover']?.checkbox === true;
                const done = props['Done']?.checkbox === true;
                
                // Skip completed tasks
                if (done || status === 'Done') {
                    return;
                }
                
                // INTELLIGENT TASK SELECTION LOGIC
                let shouldScheduleToday = false;
                let reason = '';
                
                // Explicit scheduling flags
                if (scheduleToday) {
                    shouldScheduleToday = true;
                    reason = 'Schedule Today checked';
                } else if (autoSchedule) {
                    shouldScheduleToday = true;
                    reason = 'Auto-Schedule enabled';
                } else if (carryover) {
                    shouldScheduleToday = true;
                    reason = 'Carryover task';
                } else if (fixedTime) {
                    // Check if fixed time is today
                    const fixedDate = new Date(fixedTime);
                    if (fixedDate.toDateString() === todayDate.toDateString()) {
                        shouldScheduleToday = true;
                        reason = 'Fixed time today';
                    }
                } else if (dueDate) {
                    const dueDateTime = new Date(dueDate);
                    const daysDiff = Math.ceil((dueDateTime - todayDate) / (1000 * 60 * 60 * 24));
                    
                    if (daysDiff <= 0) {
                        shouldScheduleToday = true;
                        reason = 'Overdue';
                    } else if (daysDiff <= 1) {
                        shouldScheduleToday = true;
                        reason = 'Due today/tomorrow';
                    } else if (priority === 'High' && daysDiff <= 3) {
                        shouldScheduleToday = true;
                        reason = 'High priority due soon';
                    }
                } else if (priority === 'Routine') {
                    shouldScheduleToday = true;
                    reason = 'Routine task';
                }
                
                // Skip tasks not meant for today
                if (!shouldScheduleToday) {
                    console.log(`SKIPPED: "${title}" - ${reason || 'No scheduling criteria met'}`);
                    return;
                }
                
                // Calculate priority score (lower = higher priority)
                let priorityScore = 3;
                switch(priority) {
                    case 'High':
                        priorityScore = 1;
                        break;
                    case 'Routine':
                        priorityScore = 2;
                        break;
                    case 'Medium':
                        priorityScore = 3;
                        break;
                    case 'Low':
                        priorityScore = 5;
                        break;
                }
                
                // Urgency boost for overdue/due today tasks
                if (dueDate) {
                    try {
                        const dueDateTime = new Date(dueDate);
                        const dueDays = Math.ceil((dueDateTime - todayDate) / (1000 * 60 * 60 * 24));
                        
                        if (dueDays <= 0) priorityScore = Math.max(1, priorityScore - 2); // Overdue
                        else if (dueDays <= 1) priorityScore = Math.max(1, priorityScore - 1); // Due today/tomorrow
                    } catch (dateError) {
                        console.warn(`Error parsing due date for task ${title}:`, dateError.message);
                    }
                }
                
                const taskData = {
                    title: title.trim(),
                    priority,
                    priorityScore,
                    type: (type?.toLowerCase() || 'admin').replace(' ', '-'), // Convert "Deep Work" to "deep-work"
                    estimatedTime: Math.max(15, estimatedTime || 30),
                    dueDate,
                    fixedTime,
                    scheduleToday,
                    autoSchedule,
                    carryover,
                    id: task.id,
                    url: task.url,
                    used: false,
                    reason
                };
                
                // CORRECTED: Separate fixed-time from flexible tasks
                if (fixedTime) {
                    const fixedTimePacific = utcToPacificTime(fixedTime);
                    taskData.scheduledTime = fixedTimePacific;
                    fixedTimeTasks.push(taskData);
                    console.log(`FIXED TIME TASK: "${title}" at ${fixedTimePacific} (${reason})`);
                } else {
                    flexibleTasks.push(taskData);
                    console.log(`FLEXIBLE TASK: "${title}" (${priority}) - ${reason}`);
                }
                
            } catch (taskError) {
                console.error('Error processing individual task:', taskError.message);
                console.error('Task data:', task);
            }
        });
        
        // Sort flexible tasks by priority score and urgency
        flexibleTasks.sort((a, b) => {
            if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
            if (a.carryover !== b.carryover) return b.carryover - a.carryover; // Carryover first
            return a.title.localeCompare(b.title);
        });
        
        // Sort fixed tasks by time
        fixedTimeTasks.sort((a, b) => {
            return timeStringToMinutes(a.scheduledTime) - timeStringToMinutes(b.scheduledTime);
        });
        
        console.log(`\nTask categorization complete:`);
        console.log(`   Fixed Time Tasks: ${fixedTimeTasks.length}`);
        console.log(`   Flexible Tasks: ${flexibleTasks.length}`);
        
        if (flexibleTasks.length === 0 && fixedTimeTasks.length === 0) {
            console.log('\n⚠️  WARNING: No tasks found for today!');
            console.log('   Check if tasks have "Schedule Today?" checked or due dates set');
        }
        
        return { flexibleTasks, fixedTimeTasks };
        
    } catch (error) {
        console.error('Error getting tasks:', error.message);
        console.error('Full error details:', error);
        return { flexibleTasks: [], fixedTimeTasks: [] };
    }
}

// CORRECTED: Create time blocks with proper Notion API structure
async function createTimeBlocks(schedule, today) {
    console.log(`\nCreating ${schedule.length} time blocks in Notion...`);
    
    const createdBlocks = [];
    const errors = [];
    
    for (const block of schedule) {
        try {
            // Convert to proper Notion datetime format
            const startDateTime = pacificTimeToUTC(today, block.start);
            const endDateTime = pacificTimeToUTC(today, addMinutes(block.start, block.duration));
            
            // Map types correctly
            const notionType = mapToNotionType(block.type);
            const energyLevel = mapToNotionEnergy(block.energy);
            const context = mapToNotionContext(block.context);
            
            const blockData = {
                properties: {
                    Title: {
                        title: [{ text: { content: block.title } }]
                    },
                    Type: {
                        select: { name: notionType }
                    },
                    Context: {
                        select: { name: context }
                    },
                    'Energy Requirements': {
                        select: { name: energyLevel }
                    },
                    'Start Time': {
                        date: {
                            start: startDateTime,
                            time_zone: 'America/Vancouver'
                        }
                    },
                    'End Time': {
                        date: {
                            start: endDateTime,
                            time_zone: 'America/Vancouver'
                        }
                    },
                    Status: {
                        select: { name: 'Planned' }
                    },
                    'Auto-Filled': {
                        checkbox: true
                    }
                }
            };
            
            // Add task relation if present
            if (block.taskId) {
                blockData.properties.Tasks = {
                    relation: [{ id: block.taskId }]
                };
            }
            
            // Add notes if present
            if (block.progress || block.reason) {
                const notes = [];
                if (block.progress) notes.push(`Progress: ${block.progress}`);
                if (block.reason) notes.push(`Reason: ${block.reason}`);
                
                blockData.properties.Notes = {
                    rich_text: [{ text: { content: notes.join(' | ') } }]
                };
            }
            
            const response = await notion.pages.create({
                parent: { database_id: TIME_BLOCKS_DB_ID },
                ...blockData
            });
            
            createdBlocks.push(response);
            console.log(`✓ Created: ${block.start} - ${block.title}`);
            
        } catch (error) {
            const errorMsg = `Failed to create block "${block.title}": ${error.message}`;
            console.error(`✗ ${errorMsg}`);
            errors.push(errorMsg);
        }
    }
    
    console.log(`\nTime block creation complete:`);
    console.log(`   ✓ Created: ${createdBlocks.length}`);
    console.log(`   ✗ Failed: ${errors.length}`);
    
    if (errors.length > 0) {
        console.log('\nErrors:');
        errors.forEach(error => console.log(`   - ${error}`));
    }
    
    return { created: createdBlocks, errors };
}

// Helper functions for Notion mapping
function mapToNotionType(type) {
    const typeMap = {
        'deep-work': 'Deep Work',
        'admin': 'Admin',
        'routine': 'Routine',
        'meeting': 'Meeting',
        'events': 'Events',
        'creative': 'Admin', // No creative in Time Blocks, map to Admin
        'break': 'Events'
    };
    return typeMap[type] || 'Admin';
}

function mapToNotionEnergy(energy) {
    const energyMap = {
        'high': 'High',
        'med': 'Medium',
        'medium': 'Medium',
        'low': 'Low'
    };
    return energyMap[energy?.toLowerCase()] || 'Medium';
}

function mapToNotionContext(context) {
    const contextMap = {
        'work': 'Work',
        'personal': 'Personal',
        'family': 'Family',
        'riley': 'Riley'
    };
    return contextMap[context?.toLowerCase()] || 'Work';
}

// ENHANCED: Task queue management with better logic
function getNextPriorityTask(taskQueue, availableMinutes) {
    if (!taskQueue || taskQueue.length === 0) return null;
    
    // Find the highest priority task that fits in available time
    for (let i = 0; i < taskQueue.length; i++) {
        const task = taskQueue[i];
        if (task.remainingTime > 0 && task.remainingTime <= availableMinutes) {
            return task;
        }
    }
    
    // If no task fits perfectly, return the highest priority task for partial completion
    const availableTask = taskQueue.find(task => task.remainingTime > 0);
    return availableTask || null;
}

// ENHANCED: Better conflict detection
function findFixedTimeConflict(fixedTimeTasks, slotStart) {
    return fixedTimeTasks.find(task => {
        const taskStart = timeStringToMinutes(task.scheduledTime);
        const taskEnd = taskStart + task.estimatedTime;
        const slotStartMinutes = timeStringToMinutes(slotStart);
        const slotEndMinutes = slotStartMinutes + 30; // Assuming 30min slots
        
        // Check for overlap
        return (taskStart < slotEndMinutes && taskEnd > slotStartMinutes);
    });
}

// ENHANCED: Intelligent break scheduling
function shouldAddBreak(currentTime, breakFrequency) {
    const currentMinutes = timeStringToMinutes(currentTime);
    const hoursSinceStart = (currentMinutes - timeStringToMinutes('06:00')) / 60;
    
    // Add breaks every 'breakFrequency' minutes, but not at the very start or end of day
    return hoursSinceStart > 1 && hoursSinceStart < 10 && 
           (currentMinutes % breakFrequency) < 30;
}

// ENHANCED: Time slot generation
function generateTimeSlots(startTime, endTime, slotDuration) {
    const slots = [];
    let currentTime = startTime;
    
    while (timeStringToMinutes(currentTime) < timeStringToMinutes(endTime)) {
        slots.push({
            start: currentTime,
            duration: slotDuration
        });
        currentTime = addMinutes(currentTime, slotDuration);
    }
    
    return slots;
}

// ENHANCED: End of day blocks
function addEndOfDayBlocks(schedule, workShift) {
    const endTime = workShift.isAtSite ? '17:00' : '16:30';
    
    schedule.push({
        title: 'Day Review & Tomorrow Planning',
        start: endTime,
        duration: 30,
        type: 'Admin',
        context: 'Personal',
        energy: 'Low'
    });
    
    if (!workShift.isAtSite) {
        schedule.push({
            title: 'Personal Time',
            start: addMinutes(endTime, 30),
            duration: 90,
            type: 'Events',
            context: 'Personal',
            energy: 'Low'
        });
    }
}
