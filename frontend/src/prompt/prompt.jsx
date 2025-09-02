import React, {useState} from 'react';

// old Prompt: `Explain the meaning or definition of the following text clearly and relatively concisely for a general audience make sure to go into enough depth for a basic understanding, less that 100 words.: ${selection}, here is some context, here is the parent paragraph: ${context}, here is the page heading (h1 tag): ${heading}, here is the pages URL: ${url}, do not mention any of the context in your answer e.g(urls, accessibility links etc)`

export function Prompt(selectedText, url, heading, paragraph) {
   return `You are an assistant that explains text simply and clearly.

   The user has selected the following text on a web page: ${selectedText}
   
   Here is the paragraph containing that text: ${paragraph}
   
   The page title (h1) is: ${heading}
   
   The page URL is: ${url}
   
  Task:
   1. Explain what the selected text is and how it works or is used.
   2. Do not mention the surrounding context, title, or source directly.
   3. Adapt the explanation depending on the type of selection:
      - Person’s name → explain their main contribution or role (not a full biography).
      - Equation or formula → explain what the symbols mean and what the equation does.
      - Term, definition, or jargon → explain the concept and how it works, with a simple example or analogy if helpful.
      - General phrase or sentence → rephrase in simpler terms and clarify its meaning.
   4. Keep the explanation clear and informative, focusing on function or meaning rather than history.
   5. Limit the explanation to about 2 sentences.
   `
}

export function SearchPrompt(selectedText, question, url, heading, paragraph) {
   return `
   
   You are an assistant that answers questions simply and clearly.

   The user has selected the following text on a web page:
   ${selectedText}
   
   Here is the paragraph containing that text:
   ${paragraph}
   
   The page title (h1) is:
   ${heading}
   
   The page URL is:
   ${url}
   
   The user asks this question about the selected text:
   ${question}

   Task:
   1. Answer the user’s question directly and clearly.
   2. Use the provided context to guide your answer, but never mention the context or source explicitly.
   3. Keep the answer informative and accurate:
      - If the question is about a person → focus on their role or contribution.
      - If about an equation or formula → explain the parts and what it does.
      - If about a term or concept → define it and explain how it works, with a simple example if helpful.
      - If about a phrase or sentence → clarify its meaning or usage.
   4. Avoid unnecessary history or unrelated details unless essential to the answer.
   5. Keep the explanation concise but complete (2–4 sentences).
   `
}

export function DeeperPrompt(history, question, context) {
   return `${JSON.stringify(history)}

   new follow up user message: {
   role: "user",
   content: "${question}"

   context: ${JSON.stringify(context)}
   }
   
   Reminder: Keep the answer short (2–4 sentences) and finish at a natural stopping point.
   `
}