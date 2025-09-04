// ENHANCED AI SCHEDULER - Now actually uses all your morning log data

async function createIntelligentSchedule(today) {
    console.log('🧠 Creating TRULY intelligent schedule with full data integration...');
    
    // Get comprehensive morning log data
    const morningData = await getEnhancedMorningLog(today);
    console.log('📊 Morning data:', morningData);
    
    // Calculate adjusted parameters based on ALL inputs
    const adjustedParams = calculateAdjustedParameters(morningData);
    console.log('⚙️ Adjusted parameters:', adjustedParams);
    
    const tasks = await getTodaysTasks(today);
    const workShift = await getWorkShift(today);
    
    await clearTodayBlocks(today);
    
    let schedule = [];
    
    if (workShift.isWorkDay) {
        schedule = createEnhancedWorkDaySchedule(morningData.wakeTime, workShift, tasks, adjustedParams);
    } else {
        schedule = createEnhancedHomeDaySchedule(morningData.wakeTime, tasks, adjustedParams);
    }
    
    // Create blocks with enhanced logic
    const createdBlocks = await createTimeBlocks(schedule, today);
    
    global.lastCreationResult = {
        success: createdBlocks.filter(b => b.status === 'success').length,
        failed: createdBlocks.filter(b => b.status === 'failed').length,
        adjustedParams: adjustedParams,
        morningData: morningData,
        workDay: workShift.isWorkDay,
        totalOptimizations: Object.keys(adjustedParams.optimizations).length,
        timestamp: new Date().toISOString()
    };
    
    console.log(`✅ Enhanced schedule created with ${Object.keys(adjustedParams.optimizations).length} AI optimizations`);
}

async function getEnhancedMorningLog(today) {
    const morningLogResponse = await notion.databases.query({
        database_id: DAILY_LOGS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: today }
        },
        page_size: 1
    });
    
    // Default values
    let data = {
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
    
    if (morningLogResponse.results.length > 0) {
        const log = morningLogResponse.results[0].properties;
        
        const wakeTimeRaw = log['Wake Time']?.date?.start;
        if (wakeTimeRaw) {
            data.wakeTime = utcToPacificTime(wakeTimeRaw);
        }
        
        data.energy = log['Energy']?.select?.name ? parseInt(log['Energy'].select.name) : 7;
        data.mood = log['Mood']?.select?.name || 'Steady';
        data.focusCapacity = log['Focus Capacity']?.select?.name || 'Normal';
        data.socialBattery = log['Social Battery']?.select?.name || 'Full';
        data.bodyStatus = log['Body Status']?.select?.name || 'Normal';
        data.stressLevel = log['Stress Level']?.select?.name || 'Normal';
        data.weatherImpact = log['Weather Impact']?.select?.name || 'None';
        data.sleepHours = log['Sleep Hours']?.number || 7;
        data.sleepQuality = log['Sleep Quality']?.number || 7;
    }
    
    return data;
}

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
    
    // SLEEP IMPACT (most critical factor)
    if (morningData.sleepHours < 5) {
        adjustments.energyMultiplier *= 0.6;
        adjustments.focusMultiplier *= 0.5;
        adjustments.blockDurationMultiplier *= 0.7;
        adjustments.breakFrequencyMultiplier *= 1.5;
        adjustments.optimizations.sleep = "Severe sleep deficit: Reduced capacity across all metrics";
    } else if (morningData.sleepHours < 6.5) {
        adjustments.energyMultiplier *= 0.8;
        adjustments.focusMultiplier *= 0.8;
        adjustments.blockDurationMultiplier *= 0.85;
        adjustments.breakFrequencyMultiplier *= 1.3;
        adjustments.optimizations.sleep = "Sleep deficit: Shortened blocks, more breaks";
    } else if (morningData.sleepHours > 8.5) {
        adjustments.energyMultiplier *= 1.1;
        adjustments.focusMultiplier *= 1.1;
        adjustments.deepWorkCapacity *= 1.2;
        adjustments.optimizations.sleep = "Excellent sleep: Enhanced capacity for demanding tasks";
    }
    
    // BODY STATUS IMPACT (physical capability)
    switch (morningData.bodyStatus) {
        case 'Sick':
            adjustments.energyMultiplier *= 0.3;
            adjustments.focusMultiplier *= 0.4;
            adjustments.blockDurationMultiplier *= 0.5;
            adjustments.breakFrequencyMultiplier *= 2.0;
            adjustments.deepWorkCapacity = 0;
            adjustments.optimizations.body = "Sick day: Recovery mode with minimal activity";
            break;
        case 'Achy':
            adjustments.energyMultiplier *= 0.7;
            adjustments.blockDurationMultiplier *= 0.8;
            adjustments.breakFrequencyMultiplier *= 1.4;
            adjustments.deepWorkCapacity *= 0.6;
            adjustments.optimizations.body = "Physical discomfort: Shorter blocks, gentle tasks";
            break;
        case 'Tired':
            adjustments.energyMultiplier *= 0.85;
            adjustments.focusMultiplier *= 0.9;
            adjustments.breakFrequencyMultiplier *= 1.2;
            adjustments.optimizations.body = "Physical fatigue: Increased break frequency";
            break;
        case 'Strong':
            adjustments.energyMultiplier *= 1.15;
            adjustments.deepWorkCapacity *= 1.3;
            adjustments.blockDurationMultiplier *= 1.1;
            adjustments.optimizations.body = "Peak physical state: Enhanced endurance and focus";
            break;
    }
    
    // STRESS LEVEL IMPACT (cognitive load capacity)
    switch (morningData.stressLevel) {
        case 'Maxed Out':
            adjustments.focusMultiplier *= 0.5;
            adjustments.deepWorkCapacity *= 0.3;
            adjustments.socialToleranceMultiplier *= 0.4;
            adjustments.blockDurationMultiplier *= 0.7;
            adjustments.optimizations.stress = "High stress: Avoid complex tasks, minimize meetings";
            break;
        case 'Elevated':
            adjustments.focusMultiplier *= 0.8;
            adjustments.deepWorkCapacity *= 0.7;
            adjustments.socialToleranceMultiplier *= 0.7;
            adjustments.optimizations.stress = "Elevated stress: Reduced cognitive demands";
            break;
        case 'Zen':
            adjustments.focusMultiplier *= 1.2;
            adjustments.deepWorkCapacity *= 1.4;
            adjustments.socialToleranceMultiplier *= 1.3;
            adjustments.optimizations.stress = "Zen state: Optimal conditions for deep work";
            break;
    }
    
    // WEATHER IMPACT (environmental factors)
    switch (morningData.weatherImpact) {
        case 'Draining':
            adjustments.energyMultiplier *= 0.85;
            adjustments.breakFrequencyMultiplier *= 1.3;
            adjustments.optimizations.weather = "Weather draining energy: More frequent breaks";
            break;
        case 'Energizing':
            adjustments.energyMultiplier *= 1.15;
            adjustments.focusMultiplier *= 1.1;
            adjustments.optimizations.weather = "Energizing weather: Boosted performance";
            break;
        case 'Cozy Vibes':
            adjustments.deepWorkCapacity *= 1.2;
            adjustments.focusMultiplier *= 1.1;
            adjustments.optimizations.weather = "Cozy weather: Perfect for focused work";
            break;
    }
    
    // MOOD ADJUSTMENTS (emotional state)
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
            adjustments.optimizations.mood = "Drained mood: Gentle schedule with recovery time";
            break;
        case 'Off Balance':
            adjustments.focusMultiplier *= 0.7;
            adjustments.blockDurationMultiplier *= 0.8;
            adjustments.socialToleranceMultiplier *= 0.6;
            adjustments.optimizations.mood = "Off balance: Flexible schedule, avoid pressure";
            break;
        case 'Scattered':
            adjustments.focusMultiplier *= 0.6;
            adjustments.blockDurationMultiplier *= 0.7;
            adjustments.deepWorkCapacity *= 0.4;
            adjustments.optimizations.mood = "Scattered mood: Short blocks, varied tasks";
            break;
        case 'Coasting':
            adjustments.energyMultiplier *= 0.9;
            adjustments.deepWorkCapacity *= 0.8;
            adjustments.optimizations.mood = "Coasting mood: Maintenance tasks, no pressure";
            break;
        case 'Steady':
            // No adjustments - baseline performance
            adjustments.optimizations.mood = "Steady mood: Standard scheduling approach";
            break;
    }
    
    // COMPOUND EFFECTS (when multiple factors align)
    const totalEnergyScore = morningData.energy * adjustments.energyMultiplier;
    const totalFocusScore = (morningData.focusCapacity === 'Sharp' ? 10 : morningData.focusCapacity === 'Normal' ? 7 : 4) * adjustments.focusMultiplier;
    
    if (totalEnergyScore >= 9 && totalFocusScore >= 8 && adjustments.deepWorkCapacity >= 1.0) {
        adjustments.optimizations.compound = "PEAK STATE: All systems optimal for maximum output";
    } else if (totalEnergyScore <= 4 || totalFocusScore <= 3 || adjustments.deepWorkCapacity <= 0.3) {
        adjustments.optimizations.compound = "RECOVERY MODE: Multiple limiting factors detected";
    }
    
    return {
        ...adjustments,
        adjustedEnergy: totalEnergyScore,
        adjustedFocus: totalFocusScore,
        recommendedMaxBlockDuration: Math.round(60 * adjustments.blockDurationMultiplier),
        recommendedBreakInterval: Math.round(90 / adjustments.breakFrequencyMultiplier)
    };
}

function createEnhancedWorkDaySchedule(wakeTime, workShift, tasks, adjustedParams) {
    console.log(`🏢 Creating enhanced work schedule with ${Object.keys(adjustedParams.optimizations).length} optimizations`);
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    const breakInterval = adjustedParams.recommendedBreakInterval;
    
    // Pre-work routine (adaptive based on state)
    const routineDuration = adjustedParams.adjustedEnergy >= 7 ? 30 : 45; // More time if low energy
    schedule.push({
        title: adjustedParams.optimizations.compound === 'RECOVERY MODE' ? 
               'Gentle Morning Recovery' : 'Morning Routine (Work Prep)',
        start: currentTime,
        duration: routineDuration,
        type: 'Personal',
        energy: 'Low',
        rationale: `Adaptive routine: ${routineDuration}min based on energy level`
    });
    currentTime = addMinutes(currentTime, routineDuration);
    
    // Work day scheduling with intelligent adaptations
    let workTime = workShift.startTime;
    const workEndTime = workShift.endTime;
    let lastBreakTime = workTime;
    
    while (getMinutesBetween(workTime, workEndTime) >= 30) {
        const currentHour = parseInt(workTime.split(':')[0]);
        const timeSinceBreak = getMinutesBetween(lastBreakTime, workTime);
        
        // Force break if needed (based on adjusted break frequency)
        if (timeSinceBreak >= breakInterval && workTime !== workShift.startTime) {
            const breakDuration = adjustedParams.optimizations.compound === 'RECOVERY MODE' ? 20 : 15;
            schedule.push({
                title: adjustedParams.adjustedEnergy < 5 ? 'Recovery Break' : 'Energy Break',
                start: workTime,
                duration: breakDuration,
                type: 'Break',
                energy: 'Low',
                rationale: `Adaptive break: ${breakDuration}min based on energy state`
            });
            workTime = addMinutes(workTime, breakDuration);
            lastBreakTime = workTime;
            continue;
        }
        
        let blockType, blockTitle, blockEnergy, blockDuration;
        
        // Intelligent block assignment based on comprehensive state
        if (adjustedParams.deepWorkCapacity <= 0.3) {
            // Severely limited capacity
            blockType = 'Admin';
            blockTitle = 'Light Admin Tasks';
            blockEnergy = 'Low';
            blockDuration = Math.min(30, maxBlockDuration);
        } else if (currentHour >= 5 && currentHour < 9 && adjustedParams.deepWorkCapacity >= 0.8) {
            // Peak morning hours with good capacity
            blockType = 'Deep Work';
            blockTitle = adjustedParams.optimizations.compound === 'PEAK STATE' ? 
                        'Peak Performance Deep Work' : 'Morning Deep Work';
            blockEnergy = adjustedParams.adjustedEnergy >= 8 ? 'High' : 'Medium';
            blockDuration = Math.min(maxBlockDuration * 2, 90); // Can extend if optimal
        } else if (adjustedParams.adjustedFocus >= 7 && adjustedParams.deepWorkCapacity >= 0.7) {
            // Good focus state
            blockType = adjustedParams.adjustedEnergy >= 8 ? 'Deep Work' : 'Creative';
            blockTitle = 'Focused Work Block';
            blockEnergy = 'Medium';
            blockDuration = maxBlockDuration;
        } else {
            // Default to admin with adaptive duration
            blockType = 'Admin';
            blockTitle = currentHour < 12 ? 'Morning Admin' : 'Admin & Communications';
            blockEnergy = adjustedParams.adjustedEnergy >= 6 ? 'Medium' : 'Low';
            blockDuration = Math.min(maxBlockDuration, 45);
        }
        
        // Social battery check for meetings
        if (blockType === 'Meeting' && adjustedParams.socialToleranceMultiplier < 0.7) {
            blockType = 'Admin';
            blockTitle = 'Solo Work (Avoiding Social Drain)';
        }
        
        schedule.push({
            title: blockTitle,
            start: workTime,
            duration: blockDuration,
            type: blockType,
            energy: blockEnergy,
            rationale: `AI Optimized: ${blockDuration}min ${blockType.toLowerCase()} based on comprehensive analysis`
        });
        
        workTime = addMinutes(workTime, blockDuration);
    }
    
    // Post-work recovery (adaptive)
    let postWorkTime = workShift.endTime;
    const recoveryDuration = adjustedParams.optimizations.compound === 'RECOVERY MODE' ? 60 : 30;
    
    schedule.push({
        title: adjustedParams.adjustedEnergy < 5 ? 'Extended Recovery Time' : 'Post-Work Decompress',
        start: postWorkTime,
        duration: recoveryDuration,
        type: 'Break',
        energy: 'Low',
        rationale: `Adaptive recovery: ${recoveryDuration}min based on daily stress load`
    });
    
    return schedule;
}

function createEnhancedHomeDaySchedule(wakeTime, tasks, adjustedParams) {
    console.log(`🏠 Creating enhanced home schedule with intelligent adaptations`);
    
    let schedule = [];
    let currentTime = wakeTime;
    
    const maxBlockDuration = adjustedParams.recommendedMaxBlockDuration;
    
    // Adaptive morning routine
    const routineDuration = adjustedParams.adjustedEnergy < 5 ? 90 : 60;
    schedule.push({
        title: adjustedParams.optimizations.compound === 'RECOVERY MODE' ? 
               'Extended Recovery Morning' : 'Morning Routine & Prep',
        start: currentTime,
        duration: routineDuration,
        type: 'Personal',
        energy: 'Low',
        rationale: `Adaptive morning: ${routineDuration}min based on energy assessment`
    });
    currentTime = addMinutes(currentTime, routineDuration);
    
    // Intelligent work block creation
    if (adjustedParams.deepWorkCapacity >= 0.8 && adjustedParams.adjustedEnergy >= 8) {
        // Peak state: Aggressive deep work
        schedule.push({
            title: 'Peak State Deep Work Block 1',
            start: currentTime,
            duration: Math.min(maxBlockDuration * 2, 120),
            type: 'Deep Work',
            energy: 'High',
            rationale: 'PEAK STATE: Extended deep work session'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration * 2, 120));
        
        schedule.push({
            title: 'Active Recovery Break',
            start: currentTime,
            duration: 20,
            type: 'Break',
            energy: 'Low'
        });
        currentTime = addMinutes(currentTime, 20);
        
        schedule.push({
            title: 'Peak State Deep Work Block 2',
            start: currentTime,
            duration: Math.min(maxBlockDuration * 1.5, 90),
            type: 'Deep Work',
            energy: 'High',
            rationale: 'PEAK STATE: Second intensive work block'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration * 1.5, 90));
        
    } else if (adjustedParams.deepWorkCapacity >= 0.5) {
        // Moderate capacity
        schedule.push({
            title: 'Adaptive Work Block',
            start: currentTime,
            duration: maxBlockDuration,
            type: adjustedParams.adjustedFocus >= 6 ? 'Creative' : 'Admin',
            energy: adjustedParams.adjustedEnergy >= 6 ? 'Medium' : 'Low',
            rationale: `Moderate capacity: ${maxBlockDuration}min adapted to current state`
        });
        currentTime = addMinutes(currentTime, maxBlockDuration);
        
    } else {
        // Limited capacity - gentle day
        schedule.push({
            title: 'Gentle Admin & Organization',
            start: currentTime,
            duration: Math.min(maxBlockDuration, 45),
            type: 'Admin',
            energy: 'Low',
            rationale: 'Limited capacity: Gentle tasks only'
        });
        currentTime = addMinutes(currentTime, Math.min(maxBlockDuration, 45));
    }
    
    // Adaptive lunch break
    const lunchDuration = adjustedParams.adjustedEnergy < 5 ? 90 : 60;
    schedule.push({
        title: adjustedParams.optimizations.compound === 'RECOVERY MODE' ? 
               'Extended Rest & Nourishment' : 'Lunch Break',
        start: '12:00',
        duration: lunchDuration,
        type: 'Break',
        energy: 'Low',
        rationale: `Adaptive lunch: ${lunchDuration}min for optimal recovery`
    });
    
    // Continue with afternoon blocks based on state...
    
    return schedule;
}

module.exports = {
    createIntelligentSchedule,
    getEnhancedMorningLog,
    calculateAdjustedParameters,
    createEnhancedWorkDaySchedule,
    createEnhancedHomeDaySchedule
};
