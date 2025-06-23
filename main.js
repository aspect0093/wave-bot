// Import necessary modules
const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.js'); // Bot configuration (token, mode)

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // REQUIRED for accessing message content
        GatewayIntentBits.GuildMembers, // REQUIRED for kick/ban/mute
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// A collection to store our parsed Waves commands
client.wavesCommands = new Collection();

// --- Utility Functions ---

/**
 * Parses a "Waves" command string into an executable structure.
 * This is a simplified parser using regex.
 * @param {string} waveContent The content of a .waves file.
 * @returns {object|null} An object containing the command trigger and action, or null if invalid.
 */
function parseWavesCommand(waveContent) {
    // Trim and normalize whitespace
    waveContent = waveContent.trim().replace(/\s+/g, ' ');

    // --- Command Trigger Pattern ---
    // Example: "IF user says 'hello world'"
    // This regex looks for the 'IF user says' phrase and captures the quoted trigger.
    const triggerMatch = waveContent.match(/^IF user says ['"]([^'"]+)['"]/i);
    if (!triggerMatch) {
        console.warn(`[Waves Parser] No trigger found in: ${waveContent.substring(0, 50)}...`);
        return null;
    }
    const triggerPhrase = triggerMatch[1].toLowerCase();
    // Remove the trigger part from the content to parse the action
    const actionContent = waveContent.substring(triggerMatch[0].length).trim();

    // --- Action Patterns ---
    let action = {};

    // KICK Command: "KICK @user [optional reason]"
    // Example: "KICK @user and sends 'User was naughty' in #general"
    // Captures the action, user mention, optional reason, and optional channel/message.
    let match = actionContent.match(/^KICK\s+<@!?(\d+)>(?:\s+reason\s+['"]([^'"]+)['"])?(?:\s+and\s+sends\s+['"]([^'"]+)['"](?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?)?/i);
    if (match) {
        action = {
            type: 'KICK',
            userId: match[1],
            reason: match[2] || 'No reason provided.',
            message: match[3],
            channelId: match[4],
            channelName: match[5],
        };
    }

    // BAN Command: "BAN @user [optional reason]"
    // Example: "BAN @user and sends 'Bye bye' in {1234567890}"
    else if (match = actionContent.match(/^BAN\s+<@!?(\d+)>(?:\s+reason\s+['"]([^'"]+)['"])?(?:\s+and\s+sends\s+['"]([^'"]+)['"](?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?)?/i)) {
        action = {
            type: 'BAN',
            userId: match[1],
            reason: match[2] || 'No reason provided.',
            message: match[3],
            channelId: match[4],
            channelName: match[5],
        };
    }

    // MUTE Command: "MUTE @user for [time] [unit] [optional reason]"
    // Example: "MUTE @user for 5 minutes reason 'loud'"
    else if (match = actionContent.match(/^MUTE\s+<@!?(\d+)>\s+for\s+(\d+)\s+(seconds?|minutes?|hours?|days?)(?:\s+reason\s+['"]([^'"]+)['"])?/i)) {
        const duration = parseInt(match[2]);
        const unit = match[3].toLowerCase();
        let timeInMs = 0;
        switch (unit) {
            case 'second':
            case 'seconds':
                timeInMs = duration * 1000;
                break;
            case 'minute':
            case 'minutes':
                timeInMs = duration * 60 * 1000;
                break;
            case 'hour':
            case 'hours':
                timeInMs = duration * 60 * 60 * 1000;
                break;
            case 'day':
            case 'days':
                timeInMs = duration * 24 * 60 * 60 * 1000;
                break;
            default:
                timeInMs = 0; // Invalid unit
        }
        action = {
            type: 'MUTE',
            userId: match[1],
            durationMs: timeInMs,
            reason: match[4] || 'No reason provided.',
        };
    }

    // SEND Command (single message): "SEND 'message content' [in {channel_id} | #channel_name]"
    // Example: "SEND 'Hello world!'" or "SEND 'Welcome!' in #general"
    else if (match = actionContent.match(/^SEND\s+['"]([^'"]+)['"](?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?/i)) {
        action = {
            type: 'SEND_SINGLE',
            messageContent: match[1],
            channelId: match[2],
            channelName: match[3],
        };
    }

    // SEND together Command: "SEND together 'message1' AND 'message2' ..."
    // Example: "SEND together 'First part' AND 'Second part' in {1234567890}"
    else if (match = actionContent.match(/^SEND\s+together\s+(['"](?:[^'"]+)['"](?:\s+AND\s+['"](?:[^'"]+)['"])*)(?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?/i)) {
        const messages = match[1].match(/['"]([^'"]+)['"]/g).map(m => m.slice(1, -1)); // Extract messages
        action = {
            type: 'SEND_TOGETHER',
            messages: messages,
            channelId: match[2],
            channelName: match[3],
        };
    }

    // SEND 1by1 Command: "SEND 1by1 'message1' THEN 'message2' ..."
    // Example: "SEND 1by1 'First message.' THEN 'Second message.' in #announcements"
    else if (match = actionContent.match(/^SEND\s+1by1\s+(['"](?:[^'"]+)['"](?:\s+THEN\s+['"](?:[^'"]+)['"])*)(?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?/i)) {
        const messages = match[1].match(/['"]([^'"]+)['"]/g).map(m => m.slice(1, -1)); // Extract messages
        action = {
            type: 'SEND_1BY1',
            messages: messages,
            channelId: match[2],
            channelName: match[3],
        };
    }

    // SEND EMBED Command: "SEND EMBED { ...json... }"
    // Example: "SEND EMBED { "title": "My Title", "description": "My Description" } in #info"
    else if (match = actionContent.match(/^SEND\s+EMBED\s+({.*})(?:\s+in\s+(?:<#(\d+)>|#([a-zA-Z0-9_-]+)))?/i)) {
        try {
            const embedJson = JSON.parse(match[1]);
            action = {
                type: 'SEND_EMBED',
                embedData: embedJson,
                channelId: match[2],
                channelName: match[3],
            };
        } catch (e) {
            console.error(`[Waves Parser] Invalid JSON for EMBED: ${e.message}`);
            return null;
        }
    }

    else {
        console.warn(`[Waves Parser] No recognized action found in: ${actionContent.substring(0, 50)}...`);
        return null;
    }

    return { trigger: triggerPhrase, action: action };
}

/**
 * Loads Waves commands from files.
 * @param {string} mode 'modular' or 'file'.
 * @param {string} [filePathOrFolderName] Required for 'file' or 'modular' mode.
 */
async function loadWavesCommands(mode, filePathOrFolderName) {
    console.log(`[Waves Loader] Loading commands in ${mode} mode...`);
    let filesToLoad = [];

    if (mode === 'modular') {
        const folderPath = path.join(__dirname, filePathOrFolderName);
        if (!fs.existsSync(folderPath)) {
            console.error(`[Waves Loader] Modular folder not found: ${folderPath}`);
            return;
        }
        filesToLoad = fs.readdirSync(folderPath).filter(file => file.endsWith('.waves'));
        console.log(`[Waves Loader] Found ${filesToLoad.length} .waves files in ${folderPath}`);
        filesToLoad = filesToLoad.map(file => path.join(folderPath, file)); // Get full paths
    } else if (mode === 'file') {
        const singleFilePath = path.join(__dirname, filePathOrFolderName);
        if (!fs.existsSync(singleFilePath)) {
            console.error(`[Waves Loader] Single file not found: ${singleFilePath}`);
            return;
        }
        filesToLoad.push(singleFilePath);
        console.log(`[Waves Loader] Loading single .waves file: ${singleFilePath}`);
    } else {
        console.error(`[Waves Loader] Invalid mode specified: ${mode}. Use 'modular' or 'file'.`);
        return;
    }

    for (const filePath of filesToLoad) {
        try {
            const waveContent = fs.readFileSync(filePath, 'utf8');
            const command = parseWavesCommand(waveContent);
            if (command) {
                client.wavesCommands.set(command.trigger, command.action);
                console.log(`[Waves Loader] Loaded command: '${command.trigger}' from ${path.basename(filePath)}`);
            }
        } catch (error) {
            console.error(`[Waves Loader] Error loading or parsing ${filePath}:`, error);
        }
    }
    console.log(`[Waves Loader] Finished loading. Total commands loaded: ${client.wavesCommands.size}`);
}

// --- Console Animations ---

/**
 * Displays a simple wave animation in the console.
 */
function displayWaveAnimation() {
    const frames = [
        '🌊🌊🌊🌊🌊🌊🌊',
        ' 🌊🌊🌊🌊🌊🌊',
        '  🌊🌊🌊🌊🌊',
        '   🌊🌊🌊🌊',
        '    🌊🌊🌊',
        '     🌊🌊',
        '      🌊',
        '       ',
        '      🌊',
        '     🌊🌊',
        '    🌊🌊🌊',
        '   🌊🌊🌊🌊',
        '  🌊🌊🌊🌊🌊',
        ' 🌊🌊🌊🌊🌊🌊',
        '🌊🌊🌊🌊🌊🌊🌊',
    ];
    let i = 0;
    const waveInterval = setInterval(() => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`WAVES BOT STARTING... ${frames[i % frames.length]}`);
        i++;
    }, 150);

    setTimeout(() => {
        clearInterval(waveInterval);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        console.log('✨ WAVES BOT STARTED! ✨');
        console.log('🚀 Initiating Lunar Wave sequence...');
        displayLunarWave();
    }, frames.length * 150 + 500); // Run for a bit longer than one full cycle
}

/**
 * Displays a simple lunar wave animation.
 */
function displayLunarWave() {
    const frames = [
        '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'
    ];
    let i = 0;
    const lunarWaveInterval = setInterval(() => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(`LUNAR WAVE: ${frames[i % frames.length]} `);
        i++;
    }, 200);

    // Stop after a few cycles, or you can make it indefinite if you prefer.
    setTimeout(() => {
        clearInterval(lunarWaveInterval);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        console.log('🌙 Lunar Wave complete. Ready for action! 🌙');
    }, frames.length * 3 * 200); // Run for 3 full cycles
}

// --- Discord Event Handlers ---

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    displayWaveAnimation(); // Start the cool animation
    // Load commands after bot is ready
    loadWavesCommands(config.mode, config.commandSource);
});

client.on('messageCreate', async message => {
    // Ignore bot messages and messages without content
    if (message.author.bot || !message.content) return;

    const contentLower = message.content.toLowerCase();

    // Check if the message matches any registered Waves command trigger
    for (const [trigger, action] of client.wavesCommands.entries()) {
        if (contentLower.includes(trigger.toLowerCase())) { // Using includes for more flexibility
            console.log(`[Waves Executor] Matched trigger: '${trigger}' for action type: ${action.type}`);

            // Get target member (for kick/ban/mute)
            let targetMember;
            if (action.userId) {
                try {
                    targetMember = await message.guild.members.fetch(action.userId);
                } catch (error) {
                    console.error(`[Waves Executor] Could not fetch target user ${action.userId}:`, error);
                    message.channel.send(`Error: Could not find the specified user <@${action.userId}>.`);
                    return;
                }
            }

            // Get target channel (for sending messages)
            let targetChannel = message.channel; // Default to current channel
            if (action.channelId) {
                targetChannel = client.channels.cache.get(action.channelId);
                if (!targetChannel) {
                    try {
                        targetChannel = await client.channels.fetch(action.channelId);
                    } catch (error) {
                        console.error(`[Waves Executor] Could not fetch target channel by ID ${action.channelId}:`, error);
                        message.channel.send(`Error: Could not find the specified channel with ID \`${action.channelId}\`.`);
                        return;
                    }
                }
            } else if (action.channelName) {
                targetChannel = message.guild.channels.cache.find(c => c.name === action.channelName && c.type === 0); // Type 0 is GUILD_TEXT
                if (!targetChannel) {
                    console.error(`[Waves Executor] Could not find target channel by name #${action.channelName}`);
                    message.channel.send(`Error: Could not find the specified channel \`#${action.channelName}\`.`);
                    return;
                }
            }

            // --- Execute Action based on type ---
            try {
                if (action.type === 'KICK' && targetMember) {
                    if (!message.guild.members.me.permissions.has('KICK_MEMBERS')) {
                        return message.channel.send('I do not have permissions to kick members!');
                    }
                    await targetMember.kick(action.reason);
                    if (action.message && targetChannel) {
                        await targetChannel.send(action.message.replace('{user}', targetMember.user.tag).replace('{channelid}', targetChannel.id));
                    }
                    message.channel.send(`Successfully kicked ${targetMember.user.tag}.`);
                }

                else if (action.type === 'BAN' && targetMember) {
                    if (!message.guild.members.me.permissions.has('BAN_MEMBERS')) {
                        return message.channel.send('I do not have permissions to ban members!');
                    }
                    await targetMember.ban({ reason: action.reason });
                    if (action.message && targetChannel) {
                        await targetChannel.send(action.message.replace('{user}', targetMember.user.tag).replace('{channelid}', targetChannel.id));
                    }
                    message.channel.send(`Successfully banned ${targetMember.user.tag}.`);
                }

                else if (action.type === 'MUTE' && targetMember) {
                    if (!message.guild.members.me.permissions.has('MODERATE_MEMBERS')) { // For timeouts/mutes
                        return message.channel.send('I do not have permissions to timeout/mute members!');
                    }
                    if (targetMember.communicationDisabledUntilTimestamp && targetMember.communicationDisabledUntilTimestamp > Date.now()) {
                        return message.channel.send(`${targetMember.user.tag} is already muted.`);
                    }
                    if (action.durationMs > 2419200000) { // Max mute duration is 28 days (28 * 24 * 60 * 60 * 1000 ms)
                        return message.channel.send('Mute duration cannot exceed 28 days.');
                    }

                    await targetMember.timeout(action.durationMs, action.reason);
                    message.channel.send(`Successfully muted ${targetMember.user.tag} for ${action.durationMs / 1000 / 60} minutes.`);
                }

                else if (action.type === 'SEND_SINGLE' && targetChannel) {
                    await targetChannel.send(action.messageContent);
                }

                else if (action.type === 'SEND_TOGETHER' && targetChannel) {
                    const combinedMessage = action.messages.join('\n'); // Join messages with a newline
                    await targetChannel.send(combinedMessage);
                }

                else if (action.type === 'SEND_1BY1' && targetChannel) {
                    for (const msg of action.messages) {
                        await targetChannel.send(msg);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay between messages
                    }
                }

                else if (action.type === 'SEND_EMBED' && targetChannel) {
                    const embed = new EmbedBuilder(action.embedData); // Create embed from parsed JSON
                    await targetChannel.send({ embeds: [embed] });
                }

            } catch (error) {
                console.error(`[Waves Executor] Error executing action for trigger '${trigger}':`, error);
                message.channel.send(`An error occurred while executing the command: \`${error.message}\`.`);
            }
            break; // Stop after finding the first matching command
        }
    }
});

// --- Bot Login ---
client.login(config.token);