---
name: explain
description: Explains a concept plainly to a reader new to it, supplying the prerequisites the explanation depends on, in literal terms rather than analogies. Use when the user says ELI5, asks to explain a concept simply, plainly or from scratch, or says they are new to a topic. Not for status summaries or catching up on recent changes.
---

# Explain

The reader is a capable adult who lacks this topic's background. "ELI5" asks
for this reader, not a child.

Plain language serves the intended reader (ISO 24495-1). It keeps the field's
terms and defines them, and keeps the facts the reader needs.

## 1. Pin the reader

- Infer what the reader already knows from the conversation: their role, the
  code in front of you, terms they used correctly.
- When the conversation does not show their level, assume a working
  programmer.
- When the conversation cannot show it and the answer would change the
  explanation, ask.
- Write for that one reader. An unnamed audience drifts between beginner and
  peer within one answer (Evans, "Patterns in confusing explanations").

## 2. Map the prerequisites before writing

The curse of knowledge hides the steps an expert no longer notices, and trying
harder does not remove it (Pinker, *The Sense of Style* ch. 3). Run a
procedure instead:

1. List every concept and term the explanation will use.
2. Mark each one the reader has or lacks.
3. For each one they lack, decide whether the main point needs its inner
   workings. If it does, list what its definition uses and repeat. If it does
   not, give it a one-line contract (what goes in, what comes out) and stop.
4. Order what remains so each item uses only items before it.

Step 3 follows Willison's repeated "explain the jargon you just used" prompt,
bounded by the main point. Do this before writing, and do not show the list:
its result is the Context part.

## 3. Structure

1. **The answer in one or two sentences:** what it is, and the problem it
   solves, using only terms the reader has. A term the opening cannot avoid
   gets defined in the next sentence.
2. **Context:** the missing prerequisites from step 2, each in a sentence or
   two, in dependency order.
3. **How it works, on a concrete case:** walk the mechanism through one real
   instance, from the reader's own code or domain when one exists. Then state
   the general rule it shows. Starting abstract loses the reader before the
   case arrives.
4. **Boundaries:** the one to three confusions most likely to mislead this
   reader: what it is mistaken for, when it does not apply, or the
   misconception a newcomer forms. A longer list buries the one that matters.

Scale each part to the concept, and omit a part that would be empty. Use
headings only when the answer is long enough to scan.

Give each idea its own paragraph of one to four sentences. A part may span
several paragraphs. Write a sequence of steps as a numbered list, and code as
a code block. A dense paragraph hides the structure the reader needs to
follow.

## 4. Sentences

- Define a term at first use, then use that one name for it throughout. A
  synonym reads as a new thing.
- Open a sentence with what the reader already has and end it on the new
  point (Gopen & Swan).
- One idea per sentence, in the active voice, with the verb close to its
  subject.
- Give the reason behind each rule or design, even a short one. Without the
  why, the reader cannot tell when it applies.
- Keep numbers, conditions and qualifiers. Compress the framing, not the facts.

## 5. Analogies and simplifications

Explain literally by default. A strained analogy confuses more than it
explains, and the reader carries its wrong predictions into the topic (Evans).

Add an analogy only after the literal explanation, and only when it shows a
structure the literal text cannot. Then, following Glynn's
Teaching-With-Analogies model:

- keep it to one or two sentences and one idea;
- name which part maps to which;
- state where it breaks.

To simplify, leave detail out rather than state something false. When a
simplification is not strictly true, label it and say what it leaves out.
Pratchett, Stewart and Cohen call such a statement a lie-to-children; it is
useful only when the reader knows it will be replaced.

## 6. Tone

The reader is new to the topic, not slow. Cut "imagine you're…", "think of it
like…", "it's actually pretty simple", praise for the question, and any child
framing. Do not re-explain what the reader showed they know.

## 7. Check before sending

- Is every defined term used later? Cut one that is not.
- Could any sentence go without the reader losing the point? Cut it.

## Example

The reader is a Python developer who has never written threaded code. The
Python block runs as written.

**Rejected:** "A mutex is like the key to a bathroom. Only the person holding
the key can go in, and everyone else waits in line."

The analogy does not say what the bathroom is, why two users would clash, or
that the lock protects nothing unless every thread uses it.

**Accepted:**

> A mutex (mutual-exclusion lock) stops two parts of a program that run at the
> same time from changing shared data at once.
>
> Those parts are threads. A thread is a sequence of instructions that runs
> alongside others in the same program. All threads in a program share its
> memory, so two of them can change the same variable at once.
>
> That sharing breaks a simple `count += 1`, which is three steps: read, add,
> write. Two threads can interleave them:
>
> 1. Thread A reads `count` as 5.
> 2. Thread B reads `count` as 5.
> 3. A writes 6.
> 4. B writes 6. One increment is lost.
>
> A thread acquires the mutex before the read and releases it after the
> write. A second thread that tries to acquire it in between waits until it is
> released. In Python:
>
> ```python
> import threading
>
> count = 0
> lock = threading.Lock()
>
> with lock:  # acquire; released when the block exits
>     count += 1
> ```
>
> The mutex guards nothing by itself. Code that changes `count` without
> acquiring the lock can still lose updates.
