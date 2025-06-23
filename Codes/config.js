// Bot configuration file

module.exports = {
    token: 'YOUR_BOT_TOKEN_HERE', // Replace with your actual bot token
    mode: 'modular',              // 'modular' to load from 'commands' folder, or 'file' for a single file
    commandSource: 'commands',    // If mode is 'modular', this is the folder name.
                                  // If mode is 'file', this is the path to the single .waves file (e.g., 'example.waves').
};