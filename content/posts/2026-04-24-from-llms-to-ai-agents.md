---
title: From LLMs to AI Agents: A Simple Guide to the Biggest Shift in AI
summary: Everyone is talking about AI agents. What actually are they, and how are they different from the chatbots we already use? A plain-language walk from language models to fully autonomous agents.
source: https://medium.com/@gaedokan/from-llms-to-ai-agents-a-simple-guide-to-the-biggest-shift-in-ai-4a486039b45e
---

If you've been paying attention to the AI world lately, you've probably heard the term "AI agent" thrown around everywhere. Companies are building them, engineers are hyped about them, and somehow they're supposed to be very different from the chatbots we've been using.

But what actually is an AI agent? And how is it different from ChatGPT or any other chatbot you've talked to?

In this post, I'll walk you through the evolution from plain language models to fully autonomous agents — in plain language, without the jargon.

## Starting from the beginning: what is an LLM?

An LLM (Large Language Model) is the reasoning engine behind modern AI. Think of it as a very well-trained assistant that has read most of the internet and learned how language works.

You give it text, it gives you text back. That's it.

Ask it "What's the capital of Morocco?" and it writes "Rabat." Ask it to write a poem, it writes a poem. Ask it to summarize a document, it does that too.

But here's the catch: an LLM on its own can only talk. It can't:

- Check the current weather
- Send an email
- Look at your calendar
- Book a flight
- Run a calculation with real-time data

It's like a brilliant advisor locked in a room with no phone, no internet, and no hands. Great conversation, zero action.

## The first upgrade: function calling

This is where things got interesting. Developers realized: "What if we give the LLM a list of tools it can ask to use?"

That's function calling in a nutshell. Here's how it works:

1. You ask the model: "What's the weather in Rabat?"
2. Instead of making up an answer, the model replies: "I want to call the `get_weather` function with `city = Rabat`."
3. Your code runs that function, fetches the real weather, and gives the result back to the model.
4. The model writes a nice response: "It's 22°C and sunny in Rabat."

This was huge. Suddenly, the LLM could connect to real data, real APIs, and real services. It stopped being a closed-book exam and became an open-book one.

But there's still something missing. Function calling usually happens once — you ask, it calls a function, it answers, conversation done. The model doesn't keep working on a problem on its own; it still waits for your next instruction.

And the truth is, most real tasks aren't one step. Booking a trip isn't one function call. Debugging code isn't one function call. Researching a topic isn't one function call. Each of these needs several actions in a row, where every step depends on what the previous one returned.

So here's the natural next question: what if we wrapped the whole thing in a loop? What if the model could call a tool, look at the result, think again, pick the next tool, and keep going — on its own — until the goal is actually reached?

That's where agents come in.

## The big leap: AI agents

Here's a simple, honest definition:

> An AI agent can observe the world around it and use tools to act autonomously in order to achieve a goal.

Three words matter in that sentence: **observe**, **act**, and **goal**.

### What an agent needs to exist

Every agent is built from three essential components:

- **The model** — the brain that does the thinking. Given everything the agent knows so far, the model decides what to do next. This is where the LLM lives.
- **The tools** — the hands. Tools let the agent actually do things in the world: search the web, send emails, run code, call APIs, control a browser.
- **The orchestration layer** — the control loop. It holds memory (short-term context for the current task, long-term knowledge across interactions), runs the reasoning and planning cycle, and decides when the agent is done. This is what turns a one-shot function call into a sustained, goal-directed process.

### The three core capabilities

What makes an agent actually work comes down to three things:

- **Autonomous action** — the agent doesn't just talk or suggest, it acts. It picks up tools and uses them without being told exactly which one to reach for at each moment.
- **Reasoning and planning** — the agent breaks a goal into smaller steps, decides the order, handles unexpected results, and adjusts its plan on the fly when things change.
- **Continuous learning** — the agent gets better over time. It remembers past mistakes, learns your preferences, and refines its approach with every interaction.

Together, these are what turn "an LLM that calls functions" into something that genuinely feels like a teammate.

## The 5 characteristics of an agent

If someone asks "what makes a system an agent?", here are the five traits to look for:

1. **Goal-directed.** An agent always has a goal it's working toward — whether specific ("book the cheapest flight") or broad ("help me prepare for this meeting"). Every decision it makes serves that goal.
2. **Autonomous.** It makes its own decisions inside the loop. You don't need to tell it "now search flights, now compare, now book." It figures out the next step by itself.
3. **Proactive.** It doesn't just sit and wait to be asked. If something changes — a flight gets cancelled, a meeting moves, a price drops — a good agent notices and reacts, even suggesting new actions on its own.
4. **Environment-aware.** It perceives the world around it. That means reading API responses, checking file contents, noticing error messages, picking up on user feedback. It doesn't act blindly.
5. **Tool use.** It can reach out and actually change things. Searching, writing, clicking, calling, booking, deleting — tools are how thoughts become actions.

## Where are we headed?

Let's see the same request handled at three different levels. This is the clearest way to feel the difference.

![The same request handled by an LLM, an LLM with function calling, and an AI agent](https://miro.medium.com/v2/resize:fit:1400/format:webp/1*WFnnydBumvgmM_apDWyIzw.png)

Today's agents are good at narrow tasks but struggle with anything too open-ended or long-running. They make mistakes. They sometimes loop forever. They can't always tell when they're wrong.

But the direction is clear. We're moving from AI that answers to AI that acts. From tools you use to collaborators you delegate to.

Understanding the fundamentals — the model, the tools, the memory, the five characteristics — is how you stop seeing AI agents as magic and start seeing them as something you can actually build, use and trust.
