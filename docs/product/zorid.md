Personal goal: Learn the way to use AI coding with building a massive project at maximum developing speed.

Project goal: An open-source, modern, cross-platform markdown based editor with first-class support for complex data usages like fields for notes, views like kanban, calendar, table, timeline with group sort filter, and also near-full-feature parity with obsidian)

Development steps: Complete the overall structure first(base markdown editor, basic file navigation, extensibility, electron and capacitor setup)




## Architecture Requirements

Very modular design for parallel development.
Lazy load everything as possible(like lazy.nvim)
Every part of the app, every behavior should be attachable and extensible with plugins.
Everything should be modular and able to be toggled for everything other than very core plpugins.
Performance is critical

Markdown based text editor. Include fields and custom blocks in markdown.
Sqlite indexing.


Desktop Electron, Mobile capacitor.
Custom Mobile UI elements.


### SQLite indexing, storage for plugins
Use sqlite under .zorid folder in user's vault home.


Bundle the datacore thing in the app.
Bundle the top plugin’s functionality in the app, togglable.

It should be as extensible as obsidian 


Because some stuff should be 

# Functionalities

### P0 Features

Automatic backup, timeline history

All obsidian markdown editing features(Backlinks)

Tabs

Fields, sqlite indexing

Command palatte

Search

Status bar


## P1 Features

Very well integrated syncing options(Google Drive, S3 compatiable, newest wins)



Image viewer

Markdown display customization
	Customize line spacings, font, 

Tags

File watcher, automatic update sqlite index


#### Calendar
Two way calendar sync. Caldev
List calendar sources. 

Flexible view model.


## P2 Features
(Some of the most used plugin's features. This is important because if we bundle it in out app, customizing it would be easier)

Excalidraw

Canvas

PDF view, annotation.

Views like Notion



Hotkeys for everything(Configurable of course)



### UIUX on desktop
