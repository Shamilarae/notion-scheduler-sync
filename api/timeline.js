module.exports = async function handler(req, res) {
    const TIME_BLOCKS_DB_ID = '2569f86b4f8e80439779e754eca8a066';
    const DAILY_LOGS_DB_ID = '2199f86b4f8e804e95f3c51884cff51a';
    const TASKS_DB_ID = '2169f86b4f8e802ab206f730a174b72b';
    
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Get morning log for energy/mood analysis
        const morningLogResponse = await fetch(`https://api.notion.com/v1/databases/${DAILY_LOGS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: { property: 'Date', date: { equals: today } },
                sorts: [{ timestamp: 'created_time', direction: 'descending' }],
                page_size: 1
            })
        });
        
        const morningLogData = await morningLogResponse.json();
        let wakeTime = '4:30';
        let energy = 5;
        let focusCapacity = 'Normal';
        
        if (morningLogData.results && morningLogData.results.length > 0) {
            const log = morningLogData.results[0].properties;
            const wakeTimeRaw = log['Wake Time']?.date?.start;
            if (wakeTimeRaw) {
                const wake = new Date(wakeTimeRaw);
                const pacificHours = wake.getUTCHours() - 7;
                const pacificMinutes = wake.getUTCMinutes();
                wakeTime = `${pacificHours.toString().padStart(2, '0')}:${pacificMinutes.toString().padStart(2, '0')}`;
            }
            energy = parseInt(log.Energy?.number) || 5;
            focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        }
        
        // Get tasks marked for today
        const tasksResponse = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: 'Schedule Today?', checkbox: { equals: true } },
                        { property: 'Done', checkbox: { equals: false } }
                    ]
                }
            })
        });
        
        const tasksData = await tasksResponse.json();
        
        // Categorize tasks by priority and energy requirements
        const routineTasks = [];
        const highEnergyTasks = [];
        const mediumEnergyTasks = [];
        const adminTasks = [];
        
        if (tasksData.results) {
            tasksData.results.forEach(task => {
                const name = task.properties.Name?.title?.[0]?.text?.content || 'Untitled Task';
                const priority = task.properties['Priority Level']?.select?.name || 'Medium';
                const type = task.properties.Type?.select?.name || 'Admin';
                const duration = task.properties['Estimated Duration']?.number || 60;
                
                const taskObj = { name, type, duration, priority };
                
                if (priority === 'Routine') {
                    routineTasks.push(taskObj);
                } else if (type === 'Deep Work' || name.toLowerCase().includes('report') || name.toLowerCase().includes('analysis')) {
                    highEnergyTasks.push(taskObj);
                } else if (type === 'Creative' || name.toLowerCase().includes('plan')) {
                    mediumEnergyTasks.push(taskObj);
                } else {
                    adminTasks.push(taskObj);
                }
            });
        }
        
        // Generate schedule based on energy and rules
        const schedule = [];
        let currentTime = new Date(`${today}T${wakeTime}:00.000Z`);
        
        // 1. Morning routine (personal)
        schedule.push({
            time: formatTime(currentTime),
            endTime: formatTime(addMinutes(currentTime, 30)),
            title: 'Morning Log & Planning',
            type: 'personal',
            energy: 'medium',
            details: 'Daily planning and setup'
        });
        currentTime = addMinutes(currentTime, 30);
        
        // 2. Email processing (admin)
        schedule.push({
            time: formatTime(currentTime),
            endTime: formatTime(addMinutes(currentTime, 60)),
            title: 'Email Processing',
            type: 'admin', 
            energy: 'medium',
            details: 'Clear inbox and communications'
        });
        currentTime = addMinutes(currentTime, 60);
        
        // 3. Routine work tasks (after morning routine)
        routineTasks.forEach(task => {
            schedule.push({
                time: formatTime(currentTime),
                endTime: formatTime(addMinutes(currentTime, task.duration)),
                title: task.name,
                type: 'routine-work',
                energy: 'medium',
                details: 'Routine work task'
            });
            currentTime = addMinutes(currentTime, task.duration);
        });
        
        // 4. High energy tasks (peak morning energy)
        if (energy >= 7 && focusCapacity === 'Sharp') {
            highEnergyTasks.forEach(task => {
                schedule.push({
                    time: formatTime(currentTime),
                    endTime: formatTime(addMinutes(currentTime, task.duration)),
                    title: task.name,
                    type: 'deep-work',
                    energy: 'high',
                    details: 'Deep focus work'
                });
                currentTime = addMinutes(currentTime, task.duration);
            });
        }
        
        // 5. Break for lunch (12:00-13:00)
        const lunchTime = new Date(`${today}T19:00:00.000Z`); // 12:00 PM Pacific
        if (currentTime < lunchTime) {
            currentTime = lunchTime;
        }
        schedule.push({
            time: formatTime(currentTime),
            endTime: formatTime(addMinutes(currentTime, 60)),
            title: 'Lunch Break',
            type: 'break',
            energy: 'low', 
            details: 'Eat and recharge'
        });
        currentTime = addMinutes(currentTime, 60);
        
        // 6. Afternoon tasks (medium energy)
        mediumEnergyTasks.forEach(task => {
            schedule.push({
                time: formatTime(currentTime),
                endTime: formatTime(addMinutes(currentTime, task.duration)),
                title: task.name,
                type: 'creative',
                energy: 'medium',
                details: 'Creative/strategic work'
            });
            currentTime = addMinutes(currentTime, task.duration);
        });
        
        // 7. Admin tasks (end of day)
        adminTasks.forEach(task => {
            schedule.push({
                time: formatTime(currentTime),
                endTime: formatTime(addMinutes(currentTime, task.duration)),
                title: task.name,
                type: 'admin',
                energy: 'low',
                details: 'Administrative work'
            });
            currentTime = addMinutes(currentTime, task.duration);
        });
        
        res.status(200).json({
            wakeTime,
            schedule,
            lastUpdate: new Date().toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: 'America/Los_Angeles'
            }),
            date: new Date().toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            }),
            debug: {
                energy,
                focusCapacity,
                routineTasks: routineTasks.length,
                highEnergyTasks: highEnergyTasks.length,
                totalTasks: tasksData.results?.length || 0
            }
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Scheduling system error',
            details: error.message 
        });
    }
};

function formatTime(date) {
    const pacific = new Date(date.getTime() - (7 * 60 * 60 * 1000));
    return `${pacific.getUTCHours().toString().padStart(2, '0')}:${pacific.getUTCMinutes().toString().padStart(2, '0')}`;
}

function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}
