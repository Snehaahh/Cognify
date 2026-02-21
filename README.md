#Cognify

Engineering to repair Attention Drift.

#Basic Details

Team Name: Cipher

Team Members

Member 1: Snehamol K M - Adi Shankara Institute of Engineering and Technology


#Hosted Project Link

https://github.com/Snehaahh/Cognify

#Project Description

Cognify is an intelligent browser extension that detects cognitive drift in real time using behavioral signals like tab switching, typing patterns, idle time, and mouse movement jitter. It calculates a dynamic distraction score and triggers adaptive interventions to restore focus.

#The Problem Statement

Modern users suffer from fragmented attention due to constant tab switching, aimless scrolling, and digital distractions. Traditional website blockers are rigid and context-blind, often interrupting legitimate research or productive workflows.

The Solution

Cognify introduces a multi-layer behavioral detection engine that monitors real-time browsing patterns and adapts its sensitivity using three focus modes - Deep Work, Research, and Casual. It applies progressive interventions such as grayscale filtering, notification suppression, breathing resets, and controlled tab closure while protecting productive sessions using Safe Zones.

Technical Details
Technologies/Components Used
For Software

Languages used:

JavaScript

HTML

CSS

Frameworks used:

Chrome Extension Manifest V3

Libraries used:

Chrome Tabs API

Chrome Storage API

Chrome Idle API

Tools used:

VS Code

Git

Chrome Developer Tools

Features

Feature 1: Multi-Layer Behavioral Monitoring
Tracks macro (tab switching, idle time) and micro signals (backspace ratio, mouse jitter).

Feature 2: Three Adaptive Focus Modes
Deep Work, Research, and Casual dynamically reconfigure detection thresholds.

Feature 3: Real-Time Distraction Scoring Engine
Aggregates multiple behavioral signals every 2 seconds using threshold-based logic with hysteresis control.

Feature 4: Progressive Intervention System
Applies grayscale filter, hides notifications, shows 60-second breathing reset, and closes distraction tabs.

Feature 5: Safe Zones
Prevents false interruptions on productive or learning platforms.

Feature 6: Customizable Settings Panel
Users can configure sensitivity, Safe Zones, and select focus modes.

Implementation
For Software
Installation
git clone https://github.com/your-repo/Cognify.git

Open Chrome → Extensions → Enable Developer Mode → Load Unpacked → Select project folder.

Run

The extension runs automatically once loaded into Chrome.

No server setup required.

Project Documentation
Screenshots 


Popup interface showing mode selection and toggle controls.


Grayscale intervention triggered on distraction detection.


Hard Reset breathing timer overlay before tab closure.

Diagrams
System Architecture

Architecture Diagram
Cognify consists of:

Background Service Worker

Content Scripts (Injected per page)

Website Classification Engine

Distraction Scoring Engine

UI Intervention Layer

Data Flow:

User Behavior → Signal Capture → Threshold Comparison → Score Aggregation → Intervention Trigger

Application Workflow

User selects mode → Behavior monitored → Signals evaluated every 2 seconds →
If ≥ 2 signals exceed threshold → Distraction state activated →
Intervention escalates → Focus restored or tab closed.

Project Demo
Video

[Add YouTube / Drive Demo Link Here]



AI Tools Used 

Tool Used: ChatGPT,Claude,Cursor

Purpose:

Logic refinement

Behavioral threshold structuring

Documentation drafting

Debugging suggestions

Key Prompts Used:

“How to Implement hysteresis logic for threshold systems”

“Create README documentation for hackathon project”

Percentage of AI-generated code: ~40% (logic suggestions only)

Human Contributions:

Full architecture design

Threshold engineering

Scoring system logic

Features to be added

Chrome API integration

UI/UX design

Testing & calibration
