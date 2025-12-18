# Nebula Meet

A modern, real-time video conferencing application built with React, TypeScript, and WebRTC. Clone of Google Meet with features including multi-participant video calls, screen sharing, chat, and more.

## Features

- 🎥 **Multi-participant video calls** - Support for multiple participants with mesh network architecture
- 🎤 **Audio/Video controls** - Individual control over microphone and camera
- 📺 **Screen sharing** - Share your screen with other participants
- 💬 **Real-time chat** - Chat with participants during the call
- 👥 **Participant management** - See who's in the call, host controls
- 🔊 **Sound notifications** - Audio alerts when participants join/leave
- 🎨 **Modern UI** - Beautiful, responsive interface matching Google Meet
- 📱 **Device selection** - Choose your preferred camera, microphone, and speakers
- 🔒 **Private rooms** - Secure meeting rooms with unique codes

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **PeerJS** - WebRTC peer-to-peer connections
- **WebRTC** - Real-time media streaming
- **Tailwind CSS** - Styling (via CDN)

## Prerequisites

- Node.js (v18 or higher)
- Modern web browser with WebRTC support (Chrome, Firefox, Safari, Edge)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/gauravbhatia4601/meet.git
   cd meet
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to `http://localhost:3000`

## Usage

### Starting a Meeting

1. Click "New meeting" to create an instant meeting
2. Enter your display name
3. Select your preferred devices (camera, microphone, speaker)
4. Click "Join Room" to start the meeting

### Joining a Meeting

1. Enter the meeting code in the input field
2. Enter your display name
3. Select your devices
4. Click "Join" to join the meeting

### During a Meeting

- **Mute/Unmute**: Click the microphone button
- **Turn camera on/off**: Click the video camera button
- **Share screen**: Click the screen share button
- **Chat**: Click the chat icon to open the chat panel
- **View participants**: Click the participants icon
- **End call**: Click the red phone button

## Project Structure

```
nebula-meet/
├── App.tsx              # Main application component
├── types.ts             # TypeScript type definitions
├── components/          # Reusable React components
│   ├── AudioVisualizer.tsx
│   └── Tooltip.tsx
├── services/           # Business logic services
│   ├── meetService.ts  # WebRTC peer connections
│   ├── mediaUtils.ts   # Media device utilities
│   └── geminiService.ts # AI integration (if used)
└── index.html          # HTML entry point
```

## Development

### Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

### Preview Production Build

```bash
npm run preview
```

## Architecture

The application uses a **mesh network architecture** where all participants connect directly to each other:

- **Host**: Creates the meeting and manages participant admissions
- **Guests**: Connect to the host and other participants via peer-to-peer connections
- **Signaling**: Uses PeerJS for WebRTC signaling
- **Media Streams**: Direct peer-to-peer media streams between all participants

## Browser Support

- Chrome/Edge (recommended)
- Firefox
- Safari (macOS/iOS)
- Opera

## License

This project is private and proprietary.

## Author

Gaurav Bhatia
