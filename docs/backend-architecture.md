# Backend Architecture

# Overview

Backend follows modular service-oriented architecture.

Main responsibilities:
- business logic
- authorization
- realtime synchronization
- workflow orchestration
- persistence
- audit logging

---

# Core Architecture Principles

- controllers stay thin
- services contain business logic
- repositories/data layer isolate DB access
- RBAC enforced in backend
- transactional safety prioritized
- websocket events emitted after successful mutations

---

# Main Modules

## Auth Module

Responsibilities:
- login
- token generation
- session validation
- RBAC checks
- organization/project permissions

Key rules:
- all endpoints require authorization
- ownership checks required for sensitive operations

---

## Project Module

Responsibilities:
- project CRUD
- member management
- project settings
- project visibility
- project statistics

Dependencies:
- notification module
- audit module

---

## Task Module

Responsibilities:
- task lifecycle
- comments
- attachments
- labels
- dependencies
- assignees

Important rules:
- task transitions validated server-side
- task deletion is soft-delete
- activity history preserved

---

## Time Tracking Module

Responsibilities:
- timers
- manual time entries
- overlap validation
- reporting

Critical rules:
- one active timer per user
- concurrent timer start prevented
- transactional consistency required

---

## Release Management Module

Responsibilities:
- releases
- deployment tracking
- approvals
- release notes
- SDLC prepared

Critical rules:
- releases immutable after deployment
- deployment actions audited

---

# Websocket Architecture

Websocket gateway responsible for:
- realtime task sync
- notifications
- timer sync
- release updates
- in app chat

Rules:
- events emitted only after DB commit
- failed mutations must not emit events
- reconnect logic must resync stale state

---

# Database Strategy

Database type:
- relational database

Patterns:
- transactions for multi-step mutations
- soft-delete for critical entities
- audit tables for sensitive operations

Critical consistency areas:
- permissions
- timer state
- release state
- task lifecycle

---

# Queue / Async Processing

Background jobs used for:
- emails
- notifications
- report generation
- cleanup jobs

Requirements:
- retries supported
- idempotent processing
- failure logging required

---

# Security Model

Security enforced through:
- JWT authentication
- RBAC middleware
- ownership validation
- server-side permission checks

Critical rules:
- frontend authorization never trusted
- object ownership validated in services
- audit logs preserved

---

# Known Technical Debt

## Notification System

Issues:
- duplicated event generation
- excessive websocket emissions

---

## Task Service

Issues:
- some business logic duplicated across endpoints
- large service methods require decomposition

---

# Future Improvements

Planned:
- event-driven internal architecture
- websocket event batching
- caching layer
- improved observability