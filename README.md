# Sokoban solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-green.svg)](https://nodejs.org/)
[![make.fun](https://img.shields.io/badge/make.fun-sokoban--solver--01-blue.svg)](https://make.fun/)

A push-optimal Sokoban solver, written for make.fun's sokoban-solver-01
bounty. One program, `main.ts`, answers a whole set of 5 levels in one run.

## How it works

A level is a hallway with one to four rooms off it, each room holding 3 or 4
boxes and as many goals. A box never leaves its room, so the level splits
into independent rooms: each room is solved on its own, push-optimally, and
the moves are stitched together with walks along the hallway. The push count
of the whole level is the sum of the rooms' optima.

Each room is searched over pushes, not steps. A state is the boxes' squares
plus the player's reachable region (named by its lowest square). A* orders
states by pushes made plus a minimum-cost assignment of boxes to goals, where
the cost of one box to one goal is the walking distance between them around
the walls. One push moves one box one square, so that assignment cost can drop
by at most one per push, which makes it admissible and consistent: the first
solved state A* pops is push-optimal.

Two deadlocks are pruned and never remove a solvable state: a box pushed onto
a square from which no pull brings it to a goal (a dead square), and a box
pushed into a frozen 2x2 block of walls and boxes holding a box off its goal.
The search is bounded by work (states expanded), never by the clock, so two
runs write the same bytes.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/level.txt` for each instance and writes
`/output/<id>/solution.txt`, the player's moves in LURD.

## Practice results

Scored with the kit's own scorer on the practice set:

| instance | boxes | pushes | P\* | points |
|----------|-------|--------|-----|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

Score 1,000,000 out of 1,000,000. The whole set solves in about 1 second
on one CPU, against a 60 second wall budget. The house baseline
(plain-astar 1.0.0) scores 200,000 on the same set: it only solves i001.

Fresh sets drawn from new seeds with the kit's generator score 1,000,000
too (10 out of 10 drawn sets, each solved at its own P\*).
