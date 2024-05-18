const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

// Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
    ],
});

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// When discord bot has started up
client.once('ready', () => {
    console.log('Bot is ready!');
});


const threadMap = {};

const getOpenAiThreadId = (discordThreadId) => {
    // Replace this in-memory implementation with a database (e.g. DynamoDB, Firestore, Redis)
    return threadMap[discordThreadId];
}

const addThreadToMap = (discordThreadId, openAiThreadId) => {
    threadMap[discordThreadId] = openAiThreadId;
}

const terminalStates = ["cancelled", "failed", "completed", "expired"];
const statusCheckLoop = async (openAiThreadId, runId) => {
    const run = await openai.beta.threads.runs.retrieve(
        openAiThreadId,
        runId
    );

    if (terminalStates.indexOf(run.status) < 0) {
        await sleep(1000);
        return statusCheckLoop(openAiThreadId, runId);
    }
    // console.log(run);

    return run.status;
}

const addMessage = (threadId, content) => {
    // console.log(content);
    return openai.beta.threads.messages.create(
        threadId,
        { role: "user", content }
    )
}

/**
 * Splits a Markdown string into chunks of specified max length while maintaining formatting,
 * ensuring code blocks are handled correctly.
 * @param {string} markdown - The Markdown string to be split.
 * @param {number} maxLength - The maximum length of each chunk.
 * @returns {string[]} - An array of formatted chunks.
 */
function splitMarkdownToChunks(markdown, maxLength = 1999) {
    const chunks = [];
    let currentChunk = '';
    let inCodeBlock = false;
    const lines = markdown.split('\n');

    lines.forEach((line) => {
        // Check if the line starts or ends a code block
        if (line.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }

        // Check if adding the line would exceed the max length
        if ((currentChunk + '\n' + line).length <= maxLength) {
            currentChunk += (currentChunk ? '\n' : '') + line;
        } else {
            // Push the current chunk and start a new one
            if (inCodeBlock && !line.startsWith('```')) {
                // Close the current code block and open a new one in the next chunk
                currentChunk += '\n```';
                chunks.push(currentChunk);
                currentChunk = '```' + '\n' + line;
            } else {
                chunks.push(currentChunk);
                currentChunk = line;
            }

            // Ensure the new chunk itself is not too large
            if (currentChunk.length > maxLength) {
                while (currentChunk.length > maxLength) {
                    chunks.push(currentChunk.slice(0, maxLength));
                    currentChunk = currentChunk.slice(maxLength);
                }
            }
        }
    });

    // Push any remaining content in the current chunk
    if (currentChunk) {
        // If we're in a code block, make sure to close it
        if (inCodeBlock && !currentChunk.endsWith('```')) {
            currentChunk += '\n```';
        }
        chunks.push(currentChunk);
    }

    return chunks;
}


// This event will run every time a message is received
client.on('messageCreate', async message => {
    // console.log(message.type);
    if (message.author.bot || !message.content || message.content === '') return; //Ignore bot messages
    // console.log(message);
    // sent typing indicator
    message.channel.sendTyping();
    const discordThreadId = message.channel.id;
    let openAiThreadId = getOpenAiThreadId(discordThreadId);

    let messagesLoaded = false;
    if (!openAiThreadId) {
        const thread = await openai.beta.threads.create();
        openAiThreadId = thread.id;
        addThreadToMap(discordThreadId, openAiThreadId);
        if (message.channel.isThread()) {
            //Gather all thread messages to fill out the OpenAI thread since we haven't seen this one yet
            const starterMsg = await message.channel.fetchStarterMessage();
            const otherMessagesRaw = await message.channel.messages.fetch();

            const otherMessages = Array.from(otherMessagesRaw.values())
                .map(msg => msg.content)
                .reverse(); //oldest first

            const messages = [starterMsg.content, ...otherMessages]
                .filter(msg => !!msg && msg !== '')

            // console.log(messages);
            await Promise.all(messages.map(msg => addMessage(openAiThreadId, msg)));
            messagesLoaded = true;
        }
    }

    // console.log(openAiThreadId);
    if (!messagesLoaded) { //If this is for a thread, assume msg was loaded via .fetch() earlier
        await addMessage(openAiThreadId, message.content);
    }

    const run = await openai.beta.threads.runs.create(
        openAiThreadId,
        { assistant_id: process.env.ASSISTANT_ID }
    )
    const status = await statusCheckLoop(openAiThreadId, run.id);

    const messages = await openai.beta.threads.messages.list(openAiThreadId);
    let response = messages.data[0].content[0].text.value;
    console.log(response);
    console.log('replying');

    if (response.length < 1999) {
        message.reply(response);
    } else {
        // split the response in chunks of 1999 characters and make sure you split at the new line character
        const chunks = splitMarkdownToChunks(response, 1999)
        for (let chunk of chunks) {
            message.reply(chunk);
        }
    }
});

// Authenticate Discord
client.login(process.env.DISCORD_TOKEN);