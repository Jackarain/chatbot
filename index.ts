import axios from 'axios';
import TelegramBot, { BotCommand } from 'node-telegram-bot-api';
import BingAIClient from './newbing';
import * as fs from 'fs';

// config.json 配置文件.
type Config = {
    tgToken: string;        // telegram bot 的 token.
    tgChats: number[];      // telegram 允许对话的 chat id.
    tgApiUrl: string;       // telegram-bot-api 的 url, 也可设置为 null 默认使用官方服务.

    openaiToken: string;    // openai 的 token
    openaiMode: string;     // gpt-4, gpt-3.4-turbo ...

    newbingUserToken: string;   // newbing user token (即 cookie 中的 _U)
    newbingAllCookies: string;  // newbing 所有的 cookies(如果只使用上面 newbingUserToken 无法使用的话，可以考虑使用所有 cookie 字符串)

    disable_chatgpt: boolean;   // 禁止 chatgpt
    disable_newbing: boolean;   // 禁止 newbing

    chatTimeout: number;        // 对话上下文超时时间, 超出时间将删除会话.
}


// 存储对话消息上下文结构定义.
interface ChatMessage {
    // 用于确定 telegram 消息上下文.
    id: number;
    nextid: number;

    // 通用字段, 消息内容.
    content?: string;

    // 用于 new bing 的消息上下文.
    jailbreakConversationId: any;   // 表示是否使用 jailbreakConversationId.
    bingMessageId: string;          // new bing 的 response 中的 messageId
};

// 存储会话结构.
interface ChatSession {
    // telegram 在本会话中的消息的起始id和最后一个消息id.
    start: number;
    end: number;

    // 用于 new bing 对话.
    bingSession: BingAIClient;

    // 表示经过的滴达(每秒一次)次数, 用于确定超时删除整个会话.
    tick: number;
}

// 用于构造gpt要求的上下文结构定义.

const UserRole: string = 'user';
const AssistantRole: string = 'assistant';

interface GptMessage {
    role: string;
    content: string;
}

class ChatBot {
    private bot: TelegramBot;
    private config: Config;

    private sessions: Array<ChatSession> = [];  // 对象计时.
    private messages: Array<ChatMessage> = [];  // 对象数组.

    private members: Array<number>;
    private lastChatId: number = -1;

    private typing: number = 0;
    private message_thread_id: number = 0;
    private debug: number = 1;

    private gpt_mode: string = 'gpt-3.5-turbo'; // gpt-4, gpt-3.4-turbo ...

    constructor(cfg: Config) {
        this.config = cfg;

        this.gpt_mode = this.config.openaiMode ?? this.gpt_mode;
        console.log('Using GPT Mode:', this.gpt_mode);

        this.members = this.config.tgChats;

        this.bot = new TelegramBot(this.config.tgToken, {
            polling: { autoStart: true, interval: 2000, params: { timeout: 10 } },
            baseApiUrl: this.config.tgApiUrl ?? 'https://api.telegram.org',
        });

        this.bot.onText(new RegExp('^\/bing.*? ([\\s\\S]*)', 'm'), this.on_newbing.bind(this));

        this.bot.onText(new RegExp('^\/chatgpt.*? ([\\s\\S]*)', 'm'), this.on_chatgpt.bind(this));
        this.bot.on('message', this.on_message.bind(this));

        setInterval(this.on_tick.bind(this), 1000);
    }

    checkMembers(id: number): boolean {
        return this.members.includes(id);
    }

    printDebug() {
        console.log('chats');
        this.sessions.forEach(element => {
            console.log(`${element.start} -> ${element.end} \t ${element.tick}`);
        });

        console.log('messages');
        this.messages.forEach(element => {
            console.log(element.id, '->', element.nextid, '\t:', element.content);
        });
    }

    removeMessage(id: number): number {
        let nextid: number = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].id === id) {
                nextid = this.messages[i].nextid;
                this.messages.splice(i, 1);
                break;
            }
        }
        return nextid;
    }

    removeMessages(id: number) {
        while (id != -1) {
            id = this.removeMessage(id);
        }
    }

    updateSession(id: number, nextid: number): boolean {
        for (let i = 0; i < this.sessions.length; i++) {
            const chat = this.sessions[i];
            if (chat.end === id) {
                // 重置最后消息id.
                chat.end = nextid;
                // 重置超时.
                chat.tick = 0;
                return true;
            }
        }

        // 如果是第1条消息, 则创建对话.
        this.addSession(nextid);

        return false;
    }

    updateBingSession(id: number, nextid: number): BingAIClient {
        for (let i = 0; i < this.sessions.length; i++) {
            const chat = this.sessions[i];
            if (chat.end === id) {
                // 重置最后消息id.
                chat.end = nextid;
                // 重置超时.
                chat.tick = 0;
                return chat.bingSession;
            }
        }

        // 如果是第1条消息, 则创建对话.
        return this.addBingSession(nextid);
    }

    addSession(id: number) {
        this.sessions.push(
            { start: id, end: id, tick: 0, bingSession: null }
        );
    }

    addBingSession(id: number): BingAIClient {
        const bingOptions = {
            // Necessary for some people in different countries, e.g. China (https://cn.bing.com)
            host: '',
            // "_U" cookie from bing.com
            userToken: this.config.newbingUserToken,
            // If the above doesn't work, provide all your cookies as a string instead
            cookies: this.config.newbingAllCookies ?? null,
            // A proxy string like "http://<ip>:<port>"
            proxy: '',
            // (Optional) Set to true to enable `console.debug()` logging
            debug: false,
        };

        const cacheOptions = {
            // Options for the Keyv cache, see https://www.npmjs.com/package/keyv
            // This is used for storing conversations, and supports additional drivers
            // (conversations are stored in memory by default)
            // For example, to use a JSON file (`npm i keyv-file`) as a database:
            // store: new KeyvFile({ filename: 'cache.json' }),
        };

        let session = new BingAIClient({
            ...bingOptions,
            cache: cacheOptions
        });
        this.sessions.push(
            {
                start: id,
                end: id,
                tick: 0,

                bingSession: session,
            }
        );

        return session;
    }

    findSession(end: number): number {
        for (let i = 0; i < this.sessions.length; i++) {
            const element = this.sessions[i];
            if (element.end === end) {
                return element.start;
            }
        }
        return -1;
    }

    updateMessage(id: number, nextid: number): boolean {
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            if (msg.id === id) {
                // 重置nextid.
                msg.nextid = nextid;
                return true;
            }
        }

        return false;
    }

    updateBingMessage(id: number, nextid: number): [string, string] {
        for (let i = 0; i < this.messages.length; i++) {
            const msg = this.messages[i];
            if (msg.id === id) {
                // 重置nextid.
                msg.nextid = nextid;
                return [msg.bingMessageId, msg.jailbreakConversationId];
            }
        }

        return ['', ''];
    }

    addMessage(id: number, content?: string) {
        this.messages.push(
            {
                id: id,
                content: content,
                nextid: -1,
                jailbreakConversationId: false,
                bingMessageId: null
            },
        );
    }

    addBingMessage(id: number, content?: string, messageId?: string, conversationId?: any) {
        this.messages.push(
            {
                id: id,
                content: content,
                nextid: -1,
                jailbreakConversationId: conversationId,
                bingMessageId: messageId
            },
        );
    }

    makeSession(msg: TelegramBot.Message) {
        const text = msg.text;

        if (msg.reply_to_message?.message_id === undefined) {
            this.printDebug();
            // 这是第一条消息, 直接创建一个对话.
            this.addSession(msg.message_id);
            // 存储msg到消息表.
            this.addMessage(msg.message_id, text);
        } else {
            // 存储msg到消息表.
            this.addMessage(msg.message_id, text);

            // 有对话上下文，更新对话上下文信息.
            this.updateSession(msg.reply_to_message?.message_id, msg.message_id);
            this.updateMessage(msg.reply_to_message?.message_id, msg.message_id);
        }
    }

    makeBingSession(msg: TelegramBot.Message, bingMessageId?: string, conversationId?: string)
        : [BingAIClient, string, string] {
        const text = msg?.text;
        let session: BingAIClient = null;
        let id: string = '';
        let jailbreakConversationId: string = '';

        if (msg.reply_to_message?.message_id === undefined) {
            this.printDebug();

            // 这是第一条消息, 直接创建一个 bing 对话.
            session = this.addBingSession(msg.message_id);

            // 存储msg到消息表, 第1条消息为用户发送的消息
            // 所以是没有 bingMessageId 的.
            this.addBingMessage(msg.message_id, text, bingMessageId, conversationId);
        } else {
            // 存储msg到消息表.
            this.addBingMessage(msg.message_id, text, bingMessageId, conversationId);

            // 有对话上下文，更新对话上下文信息.
            session = this.updateBingSession(
                msg.reply_to_message?.message_id,
                msg.message_id);

            [id, jailbreakConversationId] = this.updateBingMessage(
                msg.reply_to_message?.message_id,
                msg.message_id);
        }

        return [session, id, jailbreakConversationId];
    }

    makeChatContext(msg: TelegramBot.Message): Array<GptMessage> {
        let start = this.findSession(msg.message_id);
        if (start === -1) {
            console.log('Warning, not found message id:', msg.message_id);
            start = msg.message_id;
        }

        // 构造对话上下文并保存到 messages 中用于返回.
        let messages: Array<GptMessage> = [];
        let role: boolean = false;

        for (let i = 0; i < this.messages.length; i++) {
            const element = this.messages[i];
            if (element.id === start) {
                let gpt: GptMessage = {
                    role: role ? AssistantRole : UserRole,
                    content: element.content === undefined ? '' : element.content
                };
                role = !role;
                messages.push(gpt);
                start = element.nextid;
            }
        }

        return messages;
    }

    async on_message(msg: TelegramBot.Message) {
        if (!this.checkMembers(msg.chat.id)) {
            console.log('discard msg:', JSON.stringify(msg));
            return;
        }
        this.lastChatId = msg.chat.id;

        if (msg.reply_to_message !== undefined) {
            for (let i = 0; i < this.messages.length; i++) {
                const element = this.messages[i];
                if (element.id == msg.reply_to_message.message_id) {
                    if (element.bingMessageId != null)
                        await this.on_newbing(msg, null);
                    else
                        await this.on_chatgpt(msg, null);
                    return;
                }
            }
        }
    }

    async on_newbing(msg: TelegramBot.Message, match: RegExpExecArray | null) {
        if (this.config.disable_newbing)
            return;
        if (!this.checkMembers(msg.chat.id)) {
            console.log('discard msg:', JSON.stringify(msg));
            return;
        }
        this.lastChatId = msg.chat.id;

        if (match !== null) {
            msg.text = match[1];
        }

        let [session, id, jailbreakConversationId] = this.makeBingSession(msg);
        if (session == null) {
            throw Error('Session is null');
        }

        await this.bot.sendChatAction(msg.chat.id, 'typing', {
            message_thread_id: msg.message_thread_id
        });

        interface bingOpts {
            jailbreakConversationId: any;
            parentMessageId?: string;
            onProgress: (token: any) => void;
        };

        let opts: bingOpts = {
            jailbreakConversationId: true,
            onProgress: (token) => {
                process.stdout.write(token);
                this.typing++;
            }
        };

        if (jailbreakConversationId != '' && jailbreakConversationId != null) {
            opts.jailbreakConversationId = jailbreakConversationId;
        }

        if (id != '' && id != null) {
            opts.parentMessageId = id;
        }

        console.log(opts);

        let answer: string = '';
        let response: any = null;

        for (let index = 0; index < 3; index++) {
            try {
                response = await session.sendMessage(msg.text,
                    opts
                );
                answer = response.response.replace(/\s*\[\^\d+\^\]\s*/g, '');
                break;
            } catch (error) {
                console.log(error);
                continue;
            }
        }

        let reply: TelegramBot.Message;

        try {
            reply = await this.bot.sendMessage(
                msg.chat.id,
                answer,
                {
                    reply_to_message_id: msg.message_id,
                    parse_mode: 'MarkdownV2'
                }
            );

        } catch (error) {
            reply = await this.bot.sendMessage(
                msg.chat.id,
                answer,
                {
                    reply_to_message_id: msg.message_id
                }
            );
        }

        console.log("messageId:",
            response.messageId,
            "jailbreakConversationId:",
            response.jailbreakConversationId);

        this.makeBingSession(reply, response.messageId, response.jailbreakConversationId);
    }

    async on_chatgpt(msg: TelegramBot.Message, match: RegExpExecArray | null) {
        if (this.config.disable_chatgpt)
            return;
        if (!this.checkMembers(msg.chat.id)) {
            console.log('discard msg:', JSON.stringify(msg));
            return;
        }
        this.lastChatId = msg.chat.id;

        if (match !== null) {
            msg.text = match[1];
        }

        this.makeSession(msg);

        console.log(JSON.stringify(msg));

        let msgs = this.makeChatContext(msg);
        let obj = {
            model: this.gpt_mode,
            messages: msgs,
            temperature: 0.9
        };

        const data = JSON.stringify(obj);
        const config = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.config.openaiToken
            }
        };

        console.log(data);

        await this.bot.sendChatAction(msg.chat.id, 'typing', {
            message_thread_id: msg.message_thread_id
        });

        const result = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            data,
            config
        );

        const answer = result.data.choices[0].message.content;
        console.log(answer);

        let reply: TelegramBot.Message;

        try {
            reply = await this.bot.sendMessage(
                msg.chat.id,
                answer,
                {
                    reply_to_message_id: msg.message_id,
                    parse_mode: 'MarkdownV2'
                }
            );

        } catch (error) {
            reply = await this.bot.sendMessage(
                msg.chat.id,
                answer,
                {
                    reply_to_message_id: msg.message_id
                }
            );
        }

        this.makeSession(reply);
    }

    async on_tick() {
        // 更新 typing 状态.
        if (this.typing > 20) {
            this.typing = 0;

            await this.bot.sendChatAction(this.lastChatId, 'typing', {
                message_thread_id: this.message_thread_id
            });
        }

        // 更新对话上下文计时.
        this.sessions.forEach((chat: ChatSession) => {
            chat.tick++;
        });

        for (let i = this.sessions.length - 1; i >= 0; i--) {
            // 删除超过默认超过3分钟的对话上下文.
            if (this.sessions[i].tick > this.config.chatTimeout ?? 600) {
                // 超时, 删除整个对话信息.
                this.removeMessages(this.sessions[i].start);
                // 删除计时对象.
                this.sessions.splice(i, 1);
            }
        }

        // 打印调试用于输出.
        this.debug++;
        if ((this.sessions.length != 0 || this.messages.length != 0) &&
            (this.debug >= 30)) {
            this.debug = 1;
        }
    }
}


console.log('Start chatai bot');

const config: Config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
new ChatBot(config);

