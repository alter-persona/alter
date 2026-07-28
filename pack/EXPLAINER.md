# What is Understudy? (a plain-language explainer)

You talk to it, and it learns to talk like you.

Understudy is a program that lives entirely on your own computer. It asks you
questions — the kind a good biographer would ask — and you answer by just
talking, the way you'd leave a voice message. It also reads things you choose
to give it: emails you're proud of, documents you've written, exports of your
ChatGPT or Claude conversations. From all of that it builds a "digital
persona": something that answers questions the way you would, in your
phrasing, with your opinions and your knowledge of your own life and work.

## What does it collect?

Only what you give it: your interview answers (audio + transcripts), files
you upload, and chat exports you choose to import. It never reads your email,
your disk, or anything you didn't hand it.

## Where does my data live?

On your machine, full stop — a local database and local files. Nothing is
uploaded anywhere. The one nuance: to *think*, the system sends prompts to
whatever AI model you configured. If you point it at a local model (the
default option), literally nothing leaves your computer. If you configure a
cloud model for higher quality, those prompts go to that provider — the same
way any AI chat does. Voice output is off by default; enabling the
ElevenLabs voice sends the text of spoken replies to ElevenLabs.

## Why does it recommend a paid "build model"?

Two different jobs use AI here. *Talking* as your persona always uses the
local model — fast and private. *Building* the persona — distilling hours of
your answers into organized memory — is harder, and a frontier model does it
with noticeably more care. The reassurance: this choice is never final. Start
free and local; if you later add an API key, one command
(`understudy rebuild`) redoes the whole synthesis at the higher quality.
Nothing you recorded is ever lost or needs redoing.

## What do I get at the end?

A persona you can chat with as a thinking partner, and hand writing tasks to:
"reply to this email," "draft my answer to this," "what would I say here?"
It knows what you do for work, what you care about, and how you sound — and
it keeps learning from every correction you make.

## What can't it do?

It won't be you. It approximates you in writing — well enough to draft, not
to decide. It can't take actions in the world (no sending, no buying, no
calendar), it doesn't know anything you didn't tell it, and on questions that
touch who you are, it's built to *ask you* rather than guess. You can see
everything it knows, and one command deletes all of it.
