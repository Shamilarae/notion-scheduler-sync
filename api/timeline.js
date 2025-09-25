// STEP 4: INTELLIGENT TASK COLLECTION & SELECTION - SIMPLIFIED FILTERING
async function collectAndSelectTasks(today, morningData) {
    const results = {
        selectedTasks: [],
        deferredTasks: [],
        totalTasks: 0,
        errors: []
    };

    try {
        console.log('STEP 4: Collecting and selecting tasks...');
        console.log(`Today: ${today}, Energy: ${morningData.energy}`);
        
        // SIMPLIFIED: Query tasks using ONLY the Status field
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

        console.log(`Raw task query returned ${tasksResponse.results.length} results`);

        const allTasks = tasksResponse.results.map(task => {
            try {
                const props = task.properties;
                
                const title = props?.Name?.title?.[0]?.text?.content;
                if (!title || title.trim() === '') {
                    console.warn(`Skipping task with empty title: ${task.id}`);
                    return null;
                }
                
                const priority = props['Priority Level']?.select?.name || 'Medium';
                const type = props.Type?.select?.name || ''; // Keep original case
                const estimatedTime = props['Estimated Duration']?.number || 30;
                const dueDate = props['Due Date']?.date?.start;
                const fixedTime = props['Fixed Time']?.date?.start;
                const carryover = props.Carryover?.checkbox || false;
                const status = props.Status?.select?.name;
                
                // SIMPLIFIED: Only check Status field, ignore Done checkbox
                if (status === 'Done') {
                    console.log(`Skipping completed task: ${title} (Status: ${status})`);
                    return null;
                }
                
                // Calculate urgency score (1-10)
                let urgency = 3; // default
                
                if (dueDate) {
                    const today = new Date();
                    const due = new Date(dueDate);
                    const daysUntilDue = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
                    
                    if (daysUntilDue < 0) urgency = 10; // overdue
                    else if (daysUntilDue === 0) urgency = 9; // due today
                    else if (daysUntilDue === 1) urgency = 8; // due tomorrow
                    else if (daysUntilDue <= 3 && priority === 'High') urgency = 7;
                    else if (daysUntilDue <= 7 && priority === 'High') urgency = 6;
                }
                
                if (priority === 'High' && !dueDate) urgency = 5;
                if (priority === 'Routine') urgency = 3;
                if (carryover) urgency += 1;
                
                // Calculate effort score (1-4)
                let effort = 1;
                if (estimatedTime > 180) effort = 4; // huge
                else if (estimatedTime > 90) effort = 3; // large
                else if (estimatedTime > 30) effort = 2; // medium
                else effort = 1; // small
                
                const taskObj = {
                    id: task.id,
                    title: title.trim(),
                    priority,
                    type: type, // Keep original case for proper matching
                    estimatedTime: Math.max(30, estimatedTime || 30),
                    dueDate,
                    fixedTime,
                    carryover,
                    urgency,
                    effort,
                    routine: priority === 'Routine',
                    used: false,
                    status: status
                };
                
                console.log(`Found active task: "${taskObj.title}" (${taskObj.priority}, Type: "${taskObj.type}", Status: ${taskObj.status}, urgency: ${taskObj.urgency})`);
                return taskObj;
                
            } catch (taskError) {
                console.error('Error processing task:', taskError.message);
                results.errors.push(`Task processing error: ${taskError.message}`);
                return null;
            }
        }).filter(task => task !== null);

        results.totalTasks = allTasks.length;
        console.log(`Filtered to ${allTasks.length} valid active tasks`);

        if (allTasks.length === 0) {
            console.warn('No active tasks found! All tasks may be marked as Done, or database may be empty');
            return results;
        }

        // Calculate available capacity
        const isLowEnergy = morningData.energy <= 5;
        const availableHours = isLowEnergy ? 4 : 6; // conservative capacity
        const availableMinutes = availableHours * 60;
        const bufferMinutes = availableMinutes * 0.2; // 20% buffer
        const workingCapacity = availableMinutes - bufferMinutes;

        // Smart task selection
        let usedCapacity = 0;
        
        for (const task of allTasks) {
            if (usedCapacity + task.estimatedTime <= workingCapacity) {
                results.selectedTasks.push(task);
                usedCapacity += task.estimatedTime;
                task.used = true;
                console.log(`Selected task: "${task.title}" (${task.priority}, Type: "${task.type}")`);
            } else {
                results.deferredTasks.push(task);
                console.log(`Deferred task: "${task.title}" (${task.priority}) - capacity exceeded`);
            }
        }

        console.log(`Task selection complete: ${results.selectedTasks.length} selected, ${results.deferredTasks.length} deferred`);
        console.log(`Capacity utilization: ${Math.round(usedCapacity/60 * 10)/10}/${availableHours} hours`);

        return results;

    } catch (error) {
        const errorMsg = `Task collection failed: ${error.message}`;
        console.error(errorMsg);
        console.error('Full error:', error);
        results.errors.push(errorMsg);
        return results;
    }
}
