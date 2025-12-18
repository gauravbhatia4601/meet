import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Mic, MicOff, Video, VideoOff, PhoneOff,
    MessageSquare, Users, Copy, Plus, Keyboard,
    Check, X, Loader2, Link as LinkIcon, Command, ArrowRight,
    Monitor, MonitorOff, Signal, AlertCircle, Wifi, Clock, Ban
} from 'lucide-react';
import { AppView, Participant, ChatMessage, MeetingDetails, DeviceConfig, ConnectionStatus } from './types';
import { getMediaStream, getConnectedDevices, stopStream, getDisplayMediaStream, applyVideoConstraints, getAudioOnlyStream, getVideoOnlyStream, validateStream } from './services/mediaUtils';
import { generateMeetingContext } from './services/geminiService';
import { meetService } from './services/meetService';
import { AudioVisualizer } from './components/AudioVisualizer';
import { Tooltip } from './components/Tooltip';

export default function App() {
    // --- STATE ---
    const [view, setView] = useState<AppView>(AppView.LANDING);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
    const [isLoading, setIsLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Meeting Data
    const [meetingDetails, setMeetingDetails] = useState<MeetingDetails | null>(null);
    const [userName, setUserName] = useState('');
    const [meetingCode, setMeetingCode] = useState('');
    const [elapsedTime, setElapsedTime] = useState("00:00");

    // Requests
    const [joinRequestName, setJoinRequestName] = useState<string | null>(null);
    const [joinRequestId, setJoinRequestId] = useState<string | null>(null);

    // Media & Devices
    const [isMicOn, setIsMicOn] = useState(true);
    const [isCamOn, setIsCamOn] = useState(true);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [signalLevel, setSignalLevel] = useState<0 | 1 | 2 | 3>(3); // 0: Poor, 1: Fair, 2: Good, 3: Excellent

    const [devices, setDevices] = useState<{ audioInputs: MediaDeviceInfo[], videoInputs: MediaDeviceInfo[], audioOutputs: MediaDeviceInfo[] }>({ audioInputs: [], videoInputs: [], audioOutputs: [] });
    const [selectedDevices, setSelectedDevices] = useState<DeviceConfig>({ audioInput: '', audioOutput: '', videoInput: '' });

    // Room
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
    const [newMessage, setNewMessage] = useState('');
    const [showCreateOptions, setShowCreateOptions] = useState(false);
    const [createdLink, setCreatedLink] = useState<string | null>(null);

    // Refs
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null); // Ref to track active stream for cleanup
    const isRefreshingStream = useRef(false); // Guard to prevent concurrent refreshStream calls

    // URL Check
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const room = params.get('room');
        if (room) setMeetingCode(room);
    }, []);

    // Auto-clear error after 5 seconds
    useEffect(() => {
        if (errorMsg) {
            const timer = setTimeout(() => setErrorMsg(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [errorMsg]);

    // Meeting Timer
    useEffect(() => {
        if (view === AppView.MEETING && meetingDetails) {
            const interval = setInterval(() => {
                const now = Date.now();
                const diff = Math.floor((now - meetingDetails.startTime) / 1000);
                if (diff < 0) return;
                const m = Math.floor(diff / 60).toString().padStart(2, '0');
                const s = (diff % 60).toString().padStart(2, '0');
                setElapsedTime(`${m}:${s}`);
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [view, meetingDetails]);

    // --- SERVICE EVENTS ---
    useEffect(() => {
        // Play sound helper
        const playSound = (url: string) => {
            try {
                const audio = new Audio(url);
                audio.volume = 0.3;
                audio.play().catch(() => { });
            } catch (e) {
                // Ignore audio errors
            }
        };

        meetService.onStreamUpdated = (id, stream, metadata) => {
            setParticipants(prev => {
                const exists = prev.find(p => p.id === id);
                // Get name from metadata, or keep existing name if participant already exists
                const participantName = metadata?.name || exists?.name || "Participant";
                
                if (exists) {
                    return prev.map(p => p.id === id ? { 
                        ...p, 
                        stream, 
                        videoEnabled: stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled,
                        audioEnabled: stream.getAudioTracks().length > 0 && stream.getAudioTracks()[0].enabled,
                        name: participantName // Update name from metadata if available
                    } : p);
                }
                
                // New participant with stream - play join sound
                if (view === AppView.MEETING) {
                    playSound('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
                }
                
                return [...prev, {
                    id,
                    name: participantName,
                    isLocal: false,
                    videoEnabled: stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled,
                    audioEnabled: stream.getAudioTracks().length > 0 && stream.getAudioTracks()[0].enabled,
                    isSpeaking: false,
                    stream
                }];
            });
        };

        meetService.onParticipantJoined = (participant) => {
            setParticipants(prev => {
                const exists = prev.find(p => p.id === participant.id);
                if (!exists) {
                    // Play join sound
                    if (view === AppView.MEETING) {
                        playSound('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
                    }
                    return [...prev, participant];
                }
                return prev;
            });
        };

        meetService.onParticipantLeft = (id) => {
            const leftParticipant = participants.find(p => p.id === id);
            
            setParticipants(prev => prev.filter(p => p.id !== id));
            
            // Play leave sound
            if (view === AppView.MEETING && leftParticipant && !leftParticipant.isLocal) {
                playSound('https://assets.mixkit.co/active_storage/sfx/2868/2868-preview.mp3');
            }
            
            if (view === AppView.MEETING && id.includes('host') && !meetingDetails?.isHost) {
                // Simple handling if host leaves - disconnection is handled by peer error mostly, but this is a backup
                setErrorMsg("Host has left the meeting.");
            }
        };

        meetService.onJoinRequest = (id, name) => {
            setJoinRequestId(id);
            setJoinRequestName(name);
            playSound('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        };

        meetService.onJoinResponse = (accepted) => {
            if (accepted) {
                setConnectionStatus('connected');
                setView(AppView.MEETING);
            } else {
                setConnectionStatus('denied');
                setIsLoading(false);
            }
        };

        meetService.onMessageReceived = (msg) => {
            setMessages(prev => [...prev, msg]);
        };

        meetService.onParticipantStateChange = (id, state) => {
            // Only update state for the specific participant, never update local participant's state from remote
            setParticipants(prev => prev.map(p => {
                if (p.id === id && !p.isLocal) { // Only update remote participants, never local
                    return { ...p, videoEnabled: state.video, audioEnabled: state.audio, isScreenShare: state.screen };
                }
                return p;
            }));
        };

        meetService.onError = (err) => {
            console.error("Service Error:", err);
            // Silently handle some peer errors to avoid UI clutter unless critical
            if (err.type === 'peer-unavailable') {
                setErrorMsg("Host disconnected or not found.");
                setIsLoading(false);
                if (view !== AppView.LANDING) {
                    // optionally redirect or show modal
                }
            }
        };

    }, [view, meetingDetails, participants]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            // Stop all tracks
            if (streamRef.current) {
                stopStream(streamRef.current);
            }
            if (localStream) {
                stopStream(localStream);
            }
            // Cleanup service
            meetService.destroy();
        };
    }, [localStream]);

    // --- NETWORK QUALITY MONITOR ---
    useEffect(() => {
        const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;

        const updateQuality = () => {
            if (connection) {
                // Adaptive logic: If 4g use high, if 3g or slow-2g use low
                const type = connection.effectiveType; // 'slow-2g', '2g', '3g', '4g'
                let level: 0 | 1 | 2 | 3 = 3;

                if (type === 'slow-2g') level = 0;
                else if (type === '2g') level = 1;
                else if (type === '3g') level = 2;
                else level = 3;

                setSignalLevel(level);
            }
        };

        if (connection) {
            connection.addEventListener('change', updateQuality);
            updateQuality(); // Initial check
        }

        return () => {
            if (connection) connection.removeEventListener('change', updateQuality);
        }
    }, []);

    // Adaptive Video Quality - Smooth Adjustment
    useEffect(() => {
        if (isScreenSharing || view === AppView.LANDING || !localStream) return;

        const targetQuality = signalLevel <= 1 ? 'low' : 'high';
        // Apply constraints without stopping stream for smooth transition
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && videoTrack.readyState === 'live') {
            applyVideoConstraints(localStream, targetQuality).catch(err => {
                console.warn("Failed to adjust video quality:", err);
            });
        }
    }, [signalLevel, isScreenSharing, view, localStream]);

    // --- LOCAL AUDIO ACTIVITY MONITOR ---
    useEffect(() => {
        if (!localStream || !isMicOn) {
            setParticipants(prev => prev.map(p => p.isLocal && p.isSpeaking ? { ...p, isSpeaking: false } : p));
            return;
        }

        let audioContext: AudioContext;
        let interval: any;
        let source: MediaStreamAudioSourceNode;

        try {
            audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.3;

            // Use a clone to avoid interfering with sending track
            source = audioContext.createMediaStreamSource(localStream);
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            interval = setInterval(() => {
                analyser.getByteFrequencyData(dataArray);

                // Simple RMS-like calculation
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                const isSpeaking = average > 10; // Sensitivity threshold

                setParticipants(prev => {
                    const local = prev.find(p => p.isLocal);
                    if (local && local.isSpeaking !== isSpeaking) {
                        return prev.map(p => p.isLocal ? { ...p, isSpeaking } : p);
                    }
                    return prev;
                });
            }, 100);

        } catch (e) {
            console.error("Audio monitor setup failed", e);
        }

        return () => {
            if (interval) clearInterval(interval);
            if (source) source.disconnect();
            if (audioContext && audioContext.state !== 'closed') audioContext.close();
        };
    }, [localStream, isMicOn]);

    // --- DEVICE SETUP ---
    // Only load devices when entering lobby or meeting view (not on landing page)
    useEffect(() => {
        // Only load devices when in lobby or meeting view
        if (view !== AppView.LOBBY && view !== AppView.MEETING) {
            return;
        }

        const loadDevices = async () => {
            try {
                // Request permissions when loading devices for lobby/meeting
                const devs = await getConnectedDevices(true);
                setDevices({ 
                    audioInputs: devs.audioInputs, 
                    videoInputs: devs.videoInputs,
                    audioOutputs: devs.audioOutputs || []
                });
                
                // Set default devices if not already set
                setSelectedDevices(p => ({
                    ...p,
                    audioInput: p.audioInput || (devs.audioInputs[0]?.deviceId || ''),
                    videoInput: p.videoInput || (devs.videoInputs[0]?.deviceId || ''),
                    audioOutput: p.audioOutput || (devs.audioOutputs?.[0]?.deviceId || '')
                }));

                // Load saved device preferences from localStorage
                const savedDevices = localStorage.getItem('nebula-devices');
                if (savedDevices) {
                    try {
                        const saved = JSON.parse(savedDevices);
                        setSelectedDevices(prev => ({
                            ...prev,
                            audioInput: saved.audioInput || prev.audioInput,
                            videoInput: saved.videoInput || prev.videoInput,
                            audioOutput: saved.audioOutput || prev.audioOutput
                        }));
                    } catch (e) {
                        console.warn("Failed to load saved device preferences");
                    }
                }
            } catch (err) {
                console.error("Failed to get devices:", err);
            }
        };

        loadDevices();

        // Listen for device changes
        navigator.mediaDevices.addEventListener('devicechange', loadDevices);
        return () => {
            navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
        };
    }, [view]);

    // Save device preferences
    useEffect(() => {
        localStorage.setItem('nebula-devices', JSON.stringify(selectedDevices));
    }, [selectedDevices]);

    const refreshStream = useCallback(async (qualityOverride?: 'high' | 'low', forceVideo?: boolean, forceAudio?: boolean) => {
        // Prevent concurrent refresh calls
        if (isRefreshingStream.current) {
            console.warn("refreshStream already in progress, skipping");
            return;
        }
        
        isRefreshingStream.current = true;
        
        try {
        // Use ref for cleanup to avoid dependency on localStream state, preventing loops
            const oldStream = streamRef.current;
            if (oldStream && !isScreenSharing) {
                // Stop old stream tracks properly
                oldStream.getTracks().forEach(track => {
                    track.stop();
                    // Try to remove from old stream if it's still connected
                    try {
                        oldStream.removeTrack(track);
                    } catch (e) {
                        // Track might already be removed, ignore
                    }
                });
                stopStream(oldStream);
            }

        // Default quality based on current signal if not overridden
        const quality = qualityOverride || (signalLevel <= 1 ? 'low' : 'high');

            // Only request devices that are selected and not empty
            const audioDeviceId = selectedDevices.audioInput && selectedDevices.audioInput.trim() !== '' 
                ? selectedDevices.audioInput 
                : undefined;
            const videoDeviceId = selectedDevices.videoInput && selectedDevices.videoInput.trim() !== '' 
                ? selectedDevices.videoInput 
                : undefined;

            const stream = await getMediaStream(
                audioDeviceId,
                videoDeviceId,
                quality
            );

            // Validate stream has tracks
            if (!stream || (!stream.getAudioTracks().length && !stream.getVideoTracks().length)) {
                throw new Error("No tracks available in stream");
            }

            setLocalStream(stream);
            streamRef.current = stream;
            meetService.setLocalStream(stream);

            // Update participants
            setParticipants(prev => prev.map(p => p.isLocal ? { 
                ...p, 
                stream, 
                videoEnabled: isCamOn && stream.getVideoTracks().length > 0, 
                audioEnabled: isMicOn && stream.getAudioTracks().length > 0 
            } : p));

            stream.getAudioTracks().forEach(t => t.enabled = isMicOn);
            stream.getVideoTracks().forEach(t => t.enabled = isCamOn);

            // Attach stream to video element if it exists
            // Use setTimeout to ensure video element is rendered (especially in lobby)
            const attachToVideo = () => {
                if (!localVideoRef.current) {
                    return; // Element not ready yet
                }
                
                // Always set srcObject (forces re-attachment even if same stream)
                // This ensures video plays in lobby view, similar to how toggleCam works
                localVideoRef.current.srcObject = stream;
                
                // Ensure video is playing
                const playPromise = localVideoRef.current.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        if (e.name !== 'AbortError') {
                            console.error("Video play failed:", e);
                        }
                    });
                }
            };
            
            // Try multiple times with increasing delays to ensure element is rendered
            // This is especially important for lobby view where element might not be ready initially
            [0, 50, 150, 300, 500, 800].forEach(delay => {
                setTimeout(() => attachToVideo(), delay);
            });

            // If connected, replace tracks in peer connection
            if (view === AppView.MEETING) {
                const videoTrack = stream.getVideoTracks()[0];
                const audioTrack = stream.getAudioTracks()[0];
                if (videoTrack && (forceVideo !== false)) {
                    try {
                        meetService.replaceVideoTrack(videoTrack);
                    } catch (err) {
                        console.error("Failed to replace video track:", err);
                    }
                }
                if (audioTrack && (forceAudio !== false)) {
                    try {
                        meetService.replaceAudioTrack(audioTrack);
        } catch (err) {
                        console.error("Failed to replace audio track:", err);
                    }
                }
            }

        } catch (err: any) {
            console.error("Stream Error:", err);
            let errorMessage = "Failed to access camera/microphone";
            
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                errorMessage = "Camera/microphone access denied. Please allow access in your browser settings.";
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                errorMessage = "No camera or microphone found. Please connect a device and try again.";
            } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                errorMessage = "Camera/microphone is already in use by another application.";
            } else if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
                errorMessage = "Selected device doesn't meet the requirements. Please try another device.";
            } else if (err.message) {
                errorMessage = err.message;
            }
            
            setErrorMsg(errorMessage);
            
            // Clear stream references on error
            setLocalStream(null);
            streamRef.current = null;
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = null;
            }
        } finally {
            isRefreshingStream.current = false;
        }
    }, [selectedDevices, isMicOn, isCamOn, isScreenSharing, view, signalLevel]);

    const ensureVideoStream = useCallback(async () => {
        // Use ref to avoid dependency on localStream state
        const currentStream = streamRef.current || localStream;
        if (!currentStream) {
            // Create new stream if none exists
            await refreshStream(undefined, true, false);
            return;
        }

        const videoTrack = currentStream.getVideoTracks()[0];
        // Check if track doesn't exist or has ended (not just disabled)
        if (!videoTrack || videoTrack.readyState === 'ended') {
            try {
                // Get new video track
                const newStream = await getVideoOnlyStream(
                    selectedDevices.videoInput || undefined,
                    signalLevel <= 1 ? 'low' : 'high'
                );
                const newVideoTrack = newStream.getVideoTracks()[0];

                if (!newVideoTrack) {
                    throw new Error("No video track available");
                }

                // Replace in local stream
                if (videoTrack) {
                    currentStream.removeTrack(videoTrack);
                    videoTrack.stop();
                }
                currentStream.addTrack(newVideoTrack);
                newVideoTrack.enabled = isCamOn;
                
                // Update ref
                streamRef.current = currentStream;

                // Replace in all peer connections
                if (view === AppView.MEETING) {
                    meetService.replaceVideoTrack(newVideoTrack);
                }

                // Update video element
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = currentStream;
                    const playPromise = localVideoRef.current.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(e => {
                            if (e.name !== 'AbortError') {
                                console.error("Video play failed:", e);
                            }
                        });
                    }
                }

                // Update state
                setLocalStream(currentStream);

                // Update participants state
                setParticipants(prev => prev.map(p => 
                    p.isLocal ? { ...p, stream: currentStream, videoEnabled: true } : p
                ));
            } catch (err: any) {
                console.error("Failed to ensure video stream:", err);
                setErrorMsg("Failed to start camera: " + (err.message || "Permission denied"));
            }
        } else if (videoTrack.readyState === 'live') {
            // Video track exists and is live, just enable it
            videoTrack.enabled = true;
            if (localVideoRef.current) {
                // Only update srcObject if it's different to avoid interruptions
                if (localVideoRef.current.srcObject !== currentStream) {
                    localVideoRef.current.srcObject = currentStream;
                }
                const playPromise = localVideoRef.current.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        if (e.name !== 'AbortError') {
                            console.error("Video play failed:", e);
                        }
                    });
                }
            }
        }
    }, [localStream, selectedDevices, signalLevel, view, isCamOn, refreshStream]);

    const ensureAudioStream = useCallback(async () => {
        // Use ref to avoid dependency on localStream state
        const currentStream = streamRef.current || localStream;
        if (!currentStream) {
            // Create new stream if none exists
            await refreshStream(undefined, false, true);
            return;
        }

        const audioTrack = currentStream.getAudioTracks()[0];
        if (!audioTrack || audioTrack.readyState === 'ended') {
            try {
                // Get new audio track
                const newStream = await getAudioOnlyStream(selectedDevices.audioInput || undefined);
                const newAudioTrack = newStream.getAudioTracks()[0];

                if (!newAudioTrack) {
                    throw new Error("No audio track available");
                }

                // Replace in local stream
                if (audioTrack) {
                    currentStream.removeTrack(audioTrack);
                    audioTrack.stop();
                }
                currentStream.addTrack(newAudioTrack);
                newAudioTrack.enabled = isMicOn;
                
                // Update ref
                streamRef.current = currentStream;

                // Replace in all peer connections
                if (view === AppView.MEETING) {
                    meetService.replaceAudioTrack(newAudioTrack);
                }

                // Update state
                setLocalStream(currentStream);

                // Update participants state
                setParticipants(prev => prev.map(p => 
                    p.isLocal ? { ...p, stream: currentStream, audioEnabled: true } : p
                ));
            } catch (err: any) {
                console.error("Failed to ensure audio stream:", err);
                setErrorMsg("Failed to start microphone: " + (err.message || "Permission denied"));
            }
        } else if (audioTrack.readyState === 'live') {
            // Audio track exists and is live, just enable it
            audioTrack.enabled = true;
        }
    }, [localStream, selectedDevices, view, isMicOn, refreshStream]);

    // Initial stream when entering lobby - only once when entering lobby
    const hasInitializedLobby = useRef(false);
    useEffect(() => {
        if (view === AppView.LOBBY && !hasInitializedLobby.current) {
            hasInitializedLobby.current = true;
            // Wait a bit for devices to load, then initialize stream
            const initStream = async () => {
                // Small delay to ensure device loading has started
                await new Promise(resolve => setTimeout(resolve, 100));
                await refreshStream(); // Will use current signal level defaults
            };
            initStream().catch(err => {
                console.error("Failed to initialize lobby stream:", err);
                setErrorMsg("Failed to start camera/microphone. Please check permissions.");
            });
        } else if (view !== AppView.LOBBY) {
            hasInitializedLobby.current = false;
        }
    }, [view, refreshStream]);

    // Ensure video stream is attached to video element in lobby view
    useEffect(() => {
        if (view === AppView.LOBBY && localStream && isCamOn) {
            // Force attachment with retries to ensure video element is ready
            const attachVideo = () => {
                if (!localVideoRef.current) {
                    return false; // Element not ready yet
                }
                
                const videoTrack = localStream.getVideoTracks()[0];
                if (!videoTrack) {
                    return false; // No video track
                }
                
                // Always set srcObject, even if it's the same (forces re-attachment)
                localVideoRef.current.srcObject = localStream;
                
                // Ensure video is playing
                const playPromise = localVideoRef.current.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        if (e.name !== 'AbortError') {
                            console.error("Lobby video play failed:", e);
                        }
                    });
                }
                
                return true;
            };
            
            // Try multiple times with increasing delays to ensure element is rendered
            const timeouts: NodeJS.Timeout[] = [];
            [0, 50, 150, 300, 500].forEach(delay => {
                const timeout = setTimeout(() => {
                    if (attachVideo()) {
                        // Successfully attached, can stop retrying
                        timeouts.forEach(t => clearTimeout(t));
                    }
                }, delay);
                timeouts.push(timeout);
            });
            
            return () => {
                timeouts.forEach(t => clearTimeout(t));
            };
        } else if (view === AppView.LOBBY && localVideoRef.current && !isCamOn) {
            // Clear video when camera is off
            localVideoRef.current.srcObject = null;
        }
    }, [view, localStream, isCamOn]);

    const toggleMic = async () => {
        const newState = !isMicOn;
        
        // Update state immediately
        setIsMicOn(newState);
        
        if (newState) {
            // Turning mic on - ensure audio track exists
            try {
                await ensureAudioStream();
                localStream?.getAudioTracks().forEach(t => t.enabled = true);
            } catch (err: any) {
                console.error("Failed to enable microphone:", err);
                setIsMicOn(false); // Revert on error
                setErrorMsg("Failed to start microphone: " + (err.message || "Unknown error"));
                return;
            }
        } else {
            // Turning mic off - just disable the track
            localStream?.getAudioTracks().forEach(t => t.enabled = false);
        }

        // Update participants state
        setParticipants(prev => prev.map(participant => 
            participant.isLocal ? { ...participant, audioEnabled: newState } : participant
        ));

        // Broadcast state change
        if (view === AppView.MEETING) {
            meetService.broadcastState({ 
                video: isCamOn, 
                audio: newState, 
                screen: isScreenSharing 
            });
        }
    };

    const toggleCam = async () => {
        const newState = !isCamOn;
        
        // Update state immediately
        setIsCamOn(newState);
        
        if (newState) {
            // Turning camera on - ensure video track exists and is live
            try {
                await ensureVideoStream();
                localStream?.getVideoTracks().forEach(t => t.enabled = true);
                
                // Ensure video element has stream
                if (localVideoRef.current && localStream) {
                    localVideoRef.current.srcObject = localStream;
                    const playPromise = localVideoRef.current.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(e => {
                            if (e.name !== 'AbortError') {
                                console.error("Video play failed:", e);
                            }
                        });
                    }
                }
            } catch (err: any) {
                console.error("Failed to enable camera:", err);
                setIsCamOn(false); // Revert on error
                setErrorMsg("Failed to start camera: " + (err.message || "Unknown error"));
                return;
            }
        } else {
            // Turning camera off - disable track and clear video element
            localStream?.getVideoTracks().forEach(t => t.enabled = false);
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = null;
            }
        }

        // Update participants state
        setParticipants(prev => prev.map(participant => 
            participant.isLocal ? { ...participant, videoEnabled: newState } : participant
        ));

        // Broadcast state change
        if (view === AppView.MEETING) {
            meetService.broadcastState({ 
                video: newState, 
                audio: isMicOn, 
                screen: isScreenSharing 
            });
        }
    };

    const toggleScreenShare = async () => {
        if (isScreenSharing) {
            if (streamRef.current) {
                // Stop screen sharing stream
                const screenTracks = streamRef.current.getVideoTracks().filter(t => t.getSettings().displaySurface);
                screenTracks.forEach(t => t.stop());
                stopStream(streamRef.current);
            }
            setIsScreenSharing(false);
            
            // Revert to camera
            try {
                await refreshStream();
            } catch (err: any) {
                console.error("Failed to revert to camera:", err);
                setErrorMsg("Failed to revert to camera");
            }

            // Broadcast state change
            if (view === AppView.MEETING) {
                meetService.broadcastState({ 
                    video: isCamOn, 
                    audio: isMicOn, 
                    screen: false 
                });
            }
        } else {
            try {
                const stream = await getDisplayMediaStream();
                const screenTrack = stream.getVideoTracks()[0];

                if (!screenTrack) {
                    throw new Error("No screen track available");
                }

                // Handle screen share end (user stops sharing via browser UI)
                screenTrack.onended = () => {
                    setIsScreenSharing(false);
                    refreshStream().catch(err => console.error("Failed to refresh stream:", err));
                };

                // Preserve audio track from local stream
                const audioTrack = localStream?.getAudioTracks()[0];
                if (audioTrack) {
                    stream.addTrack(audioTrack.clone());
                }

                // Stop old video track if exists
                const oldVideoTrack = localStream?.getVideoTracks().find(t => !t.getSettings().displaySurface);
                if (oldVideoTrack) {
                    oldVideoTrack.stop();
                }

                // Update stream
                setLocalStream(stream);
                streamRef.current = stream;
                meetService.setLocalStream(stream);
                setParticipants(prev => prev.map(p => p.isLocal ? { ...p, stream, isScreenShare: true } : p));

                // Update video element
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = stream;
                    const playPromise = localVideoRef.current.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(e => {
                            if (e.name !== 'AbortError') {
                                console.error("Video play failed:", e);
                            }
                        });
                    }
                }

                // Replace video track in peer connections
                if (view === AppView.MEETING) {
                meetService.replaceVideoTrack(screenTrack);
                }

                setIsScreenSharing(true);
                setIsCamOn(true);

                // Broadcast state change
                if (view === AppView.MEETING) {
                    meetService.broadcastState({ 
                        video: true, 
                        audio: isMicOn, 
                        screen: true 
                    });
                }

            } catch (e: any) {
                console.error("Screen share failed", e);
                if (e.name === 'NotAllowedError') {
                    setErrorMsg("Screen sharing permission denied. Please allow screen sharing in your browser.");
                } else if (e.name === 'NotFoundError') {
                    setErrorMsg("No screen, window, or tab available to share.");
                } else {
                    setErrorMsg("Failed to share screen: " + (e.message || "Unknown error"));
                }
            }
        }
    };

    const handleKick = (participantId: string) => {
        if (window.confirm("Are you sure you want to remove this participant?")) {
            meetService.kickParticipant(participantId);
        }
    };

    // --- ACTIONS ---

    const generateRoomId = () => {
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        const gen = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        return `${gen(3)}-${gen(4)}-${gen(3)}`;
    };

    const setHostToken = (code: string) => {
        localStorage.setItem(`nebula-host-${code}`, 'true');
    };

    const isHostTokenPresent = (code: string) => {
        return localStorage.getItem(`nebula-host-${code}`) === 'true';
    };

    const handleCreateInstant = async () => {
        const meetingId = generateRoomId();
        setMeetingCode(meetingId);
        setHostToken(meetingId); // Claim Authority
        setMeetingDetails({ id: meetingId, title: "Instant Meeting", description: "Ready to start", startTime: Date.now(), isHost: true });
        // Set view to lobby - this will trigger device loading and stream initialization
        setView(AppView.LOBBY);
    };

    const handleCreateForLater = () => {
        const meetingId = generateRoomId();
        setHostToken(meetingId); // Claim Authority
        setCreatedLink(`${window.location.origin}?room=${meetingId}`);
        setMeetingCode(meetingId);
        setShowCreateOptions(false);
    };

    const handleEnterLobbyWithCode = async () => {
        if (!meetingCode) return;
        const code = meetingCode.trim().toLowerCase();
        setErrorMsg(null);
        setMeetingCode(code);

        // Check if we are the Creator (Host)
        const isCreator = isHostTokenPresent(code);

        setMeetingDetails({
            id: code,
            title: "Meeting",
            description: isCreator ? "You are the Host" : "Secure Connection",
            startTime: Date.now(),
            isHost: isCreator
        });
        setView(AppView.LOBBY);
    };

    const handleCodeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        if (val.includes('http') || val.includes('room=')) {
            try {
                const url = new URL(val);
                const r = url.searchParams.get('room');
                if (r) {
                    setMeetingCode(r.trim());
                    return;
                }
            } catch (err) { }
            const match = val.match(/room=([^&]*)/);
            if (match) {
                setMeetingCode(match[1].trim());
                return;
            }
        }
        setMeetingCode(val);
    };

    const attemptGuestJoin = async (hostId: string) => {
        // PROBE LOOP
        if (connectionStatus === 'connected') return; // Already joined?

        // 1. Check if host is online
        const hostExists = await meetService.checkHostAvailability(hostId);

        if (hostExists) {
            console.log("[App] Host found! Connecting...");
            setConnectionStatus('knocking');
            meetService.joinMeeting(hostId, userName);
            setView(AppView.JOINING); // Show "Knocking..."
        } else {
            console.log("[App] Host offline. Waiting...");
            setView(AppView.WAITING_FOR_HOST); // Show "Waiting..."
            // Retry in 3s if still in Waiting view
            setTimeout(() => {
                // Check view ref or state in a functional update to ensure we didn't leave
                // For simplicity here, we rely on user manually retrying or a resilient service loop.
                // But to automate:
                attemptGuestJoin(hostId);
            }, 3000);
        }
    };

    const handleJoinCall = async () => {
        if (!userName.trim()) return;
        setIsLoading(true);
        setErrorMsg(null);

        if (!localStream) {
            setErrorMsg("No media stream. Check camera/mic permissions.");
            setIsLoading(false);
            return;
        }

        const cleanCode = meetingCode.trim().toLowerCase();
        const hostPeerId = `nebula-meet-${cleanCode}-host`;

        // 1. Initialize Peer
        if (!meetingDetails?.isHost) {
            // GUEST INITIALIZATION
            try {
                await meetService.init(); // Random ID
                meetService.setLocalName(userName); // Set local name for broadcasting
                setParticipants([{
                    id: 'local',
                    name: userName,
                    isLocal: true,
                    videoEnabled: isCamOn,
                    audioEnabled: isMicOn,
                    isSpeaking: false,
                    stream: localStream
                }]);

                // Start Polling Loop
                attemptGuestJoin(hostPeerId);

            } catch (e: any) {
                setErrorMsg("Consnection failed: " + e.message);
                setIsLoading(false);
            }
        } else {
            // HOST INITIALIZATION
            try {
                await meetService.init(hostPeerId); // Claim Host ID
                meetService.setLocalName(userName); // Set local name for broadcasting
                setParticipants([{
                    id: 'local',
                    name: userName + " (Host)",
                    isLocal: true,
                    videoEnabled: isCamOn,
                    audioEnabled: isMicOn,
                    isSpeaking: false,
                    stream: localStream
                }]);
                setView(AppView.MEETING);
            } catch (e: any) {
                setErrorMsg("Failed to start meeting (Host ID unavailable). Is the meeting already running?");
                setIsLoading(false);
            }
        }
    };

    // --- RENDER ---

    if (view === AppView.LANDING) {
        return (
            <div className="min-h-screen w-full flex flex-col items-center justify-center relative font-sans text-white aurora-bg">
                {/* Navbar */}
                <nav className="absolute top-0 left-0 w-full p-8 flex justify-between items-center z-20">
                    {/* Logo */}
                    <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center">
                            <Video className="w-3.5 h-3.5 text-white" />
                        </div>
                        <span className="font-display font-medium tracking-tight text-xl text-white/90">Nebula Meet</span>
                    </div>
                    {/* Clock */}
                    <div className="text-sm text-white/40 font-mono hidden sm:block">
                        {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                </nav>

                <div className="z-10 w-full max-w-6xl px-6 grid lg:grid-cols-2 gap-12 items-center">

                    {/* Left Content */}
                    <div className="flex flex-col items-start text-left space-y-8">
                        <h1 className="text-5xl md:text-6xl lg:text-7xl font-display font-medium tracking-tight leading-[1.1]">
                            Premium video meetings. <br />
                            <span className="text-white/40">Now free for everyone.</span>
                        </h1>
                        <p className="text-lg text-white/50 max-w-xl font-light leading-relaxed">
                            We re-engineered the service we built for secure business meetings, Google Meet, to make it free and available for all.
                        </p>

                        {/* Actions Row */}
                        <div className="w-full flex flex-col sm:flex-row items-center gap-4 relative">

                            {/* New Meeting Button */}
                            <div className="relative w-full sm:w-auto">
                                <button
                                    onClick={() => setShowCreateOptions(!showCreateOptions)}
                                    className="w-full sm:w-auto px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium flex items-center justify-center gap-3 transition-all shadow-lg shadow-blue-900/20"
                                >
                                    <Video className="w-5 h-5" />
                                    <span>New meeting</span>
                                </button>

                                {/* Dropdown */}
                                {showCreateOptions && (
                                    <div className="absolute top-full left-0 mt-3 w-72 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50 flex flex-col py-2 animate-enter">
                                        <button onClick={handleCreateForLater} className="px-5 py-3.5 text-left hover:bg-white/5 flex items-center gap-3 text-sm text-white/90 transition-colors">
                                            <LinkIcon className="w-5 h-5 text-white/70" />
                                            <span>Create a meeting for later</span>
                                        </button>
                                        <button onClick={handleCreateInstant} disabled={isLoading} className="px-5 py-3.5 text-left hover:bg-white/5 flex items-center gap-3 text-sm text-white/90 transition-colors">
                                            <Plus className="w-5 h-5 text-white/70" />
                                            <span>Start an instant meeting</span>
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* Code Input */}
                            <div className="relative w-full sm:max-w-xs flex items-center group">
                                <div className="absolute left-4 text-white/50 pointer-events-none">
                                    <Keyboard className="w-5 h-5" />
                                </div>
                                <input
                                    type="text"
                                    value={meetingCode}
                                    onChange={handleCodeInput}
                                    onFocus={() => setShowCreateOptions(false)}
                                    placeholder="Enter a code or link"
                                    className="w-full bg-[#1a1a1a] border border-white/10 rounded-xl pl-12 pr-16 py-4 text-white placeholder:text-white/40 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 focus:outline-none transition-all"
                                    onKeyDown={(e) => e.key === 'Enter' && handleEnterLobbyWithCode()}
                                />
                                {meetingCode && (
                                    <button
                                        onClick={handleEnterLobbyWithCode}
                                        className="absolute right-3 px-3 py-1.5 text-sm font-medium text-blue-400 hover:bg-blue-500/10 rounded-lg hover:text-blue-300 transition-colors"
                                    >
                                        Join
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Link Created Modal/Toast */}
                        {createdLink && (
                            <div className="mt-4 p-4 bg-white/5 border border-white/10 rounded-xl max-w-md w-full animate-enter">
                                <div className="flex justify-between items-start mb-2">
                                    <span className="text-sm font-medium text-white/90">Here's the link to your meeting</span>
                                    <button onClick={() => setCreatedLink(null)}><X className="w-4 h-4 text-white/30 hover:text-white" /></button>
                                </div>
                                <p className="text-xs text-white/50 mb-3">Copy this link and send it to people you want to meet with. Be sure to save it so you can use it later, too.</p>
                                <div className="flex items-center gap-2 bg-black/30 rounded-lg p-2">
                                    <span className="flex-1 font-mono text-xs truncate text-blue-200 select-all">{createdLink}</span>
                                    <button onClick={() => navigator.clipboard.writeText(createdLink!)} className="p-1.5 hover:bg-white/10 rounded text-white/70 hover:text-white">
                                        <Copy className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="border-t border-white/10 w-full pt-6 mt-4">
                            <p className="text-white/30 text-sm">
                                <a href="#" className="hover:text-blue-400 transition-colors">Learn more</a> about Nebula Meet
                            </p>
                        </div>
                    </div>

                    {/* Right Illustration (Carousel/Hero) */}
                    <div className="hidden lg:flex items-center justify-center relative">
                        {/* Abstract representation of a meeting or carousel - removed animation zoom as requested */}
                        <div className="relative w-[500px] h-[500px]">
                            <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/20 to-purple-500/20 rounded-full blur-3xl opacity-30"></div>
                            <div className="absolute inset-10 bg-white/5 border border-white/10 rounded-2xl backdrop-blur-sm p-4 flex flex-col gap-4 shadow-2xl">
                                <div className="grid grid-cols-2 gap-4 h-full overflow-hidden">
                                    <div className="relative bg-white/5 rounded-xl overflow-hidden group">
                                        <img src="https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?q=80&w=400&auto=format&fit=crop" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Participant" />
                                        <div className="absolute bottom-2 left-2 text-[10px] font-medium bg-black/40 backdrop-blur px-2 py-1 rounded">Sarah</div>
                                    </div>
                                    <div className="relative bg-white/5 rounded-xl overflow-hidden group">
                                        <img src="https://images.unsplash.com/photo-1560250097-0b93528c311a?q=80&w=400&auto=format&fit=crop" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Participant" />
                                        <div className="absolute bottom-2 left-2 text-[10px] font-medium bg-black/40 backdrop-blur px-2 py-1 rounded">David</div>
                                    </div>
                                    <div className="relative bg-white/5 rounded-xl overflow-hidden group">
                                        <img src="https://images.unsplash.com/photo-1580489944761-15a19d654956?q=80&w=400&auto=format&fit=crop" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Participant" />
                                        <div className="absolute bottom-2 left-2 text-[10px] font-medium bg-black/40 backdrop-blur px-2 py-1 rounded">Jessica</div>
                                        <div className="absolute top-2 right-2 p-1.5 bg-blue-500 rounded-full animate-pulse shadow-lg">
                                            <Mic className="w-3 h-3 text-white" />
                                        </div>
                                    </div>
                                    <div className="relative bg-white/5 rounded-xl overflow-hidden group">
                                        <img src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=400&auto=format&fit=crop" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Participant" />
                                        <div className="absolute bottom-2 left-2 text-[10px] font-medium bg-black/40 backdrop-blur px-2 py-1 rounded">Michael</div>
                                    </div>
                                </div>
                                <div className="h-12 bg-white/5 rounded-xl flex items-center justify-center gap-4">
                                    <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                                        <PhoneOff className="w-4 h-4 text-red-500" />
                                    </div>
                                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                                        <Mic className="w-4 h-4 text-white" />
                                    </div>
                                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                                        <Video className="w-4 h-4 text-white" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        );
    }

    // --- LOBBY VIEW ---
    if (view === AppView.LOBBY) {
        return (
            <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 relative">
                <div className="aurora-bg absolute inset-0 opacity-30"></div>

                <div className="z-10 w-full max-w-5xl grid md:grid-cols-5 gap-8 items-center h-[70vh]">
                    <div className="md:col-span-3 h-full bg-[#111] rounded-[2rem] overflow-hidden relative border border-white/10 shadow-2xl group">
                        {isCamOn ? (
                        <video
                            ref={localVideoRef}
                            autoPlay muted playsInline
                                className="w-full h-full object-cover transform scale-x-[-1]"
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0a]">
                                <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center backdrop-blur">
                                    {userName ? (
                                        <span className="text-4xl font-display font-medium text-white/90">
                                            {(() => {
                                                const parts = userName.trim().split(/\s+/);
                                                return parts.length >= 2 
                                                    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                                                    : userName[0]?.toUpperCase() || '?';
                                            })()}
                                        </span>
                                    ) : (
                                        <Users className="w-10 h-10 text-white/30" />
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-4 glass px-4 py-3 rounded-full">
                            <button onClick={toggleMic} className={`p-3 rounded-full transition-all ${!isMicOn ? 'bg-red-500/20 text-red-500' : 'hover:bg-white/10 text-white'}`}>
                                {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                            </button>
                            <button onClick={toggleCam} className={`p-3 rounded-full transition-all ${!isCamOn ? 'bg-red-500/20 text-red-500' : 'hover:bg-white/10 text-white'}`}>
                                {isCamOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                            </button>
                        </div>

                        <div className="absolute top-6 right-6 flex items-center gap-2">
                            <div className={`glass px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 transition-colors ${signalLevel === 3 ? 'text-green-400 bg-green-400/10 border-green-400/20' :
                                signalLevel === 2 ? 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' :
                                    signalLevel === 1 ? 'text-orange-400 bg-orange-400/10 border-orange-400/20' :
                                        'text-red-400 bg-red-400/10 border-red-400/20'
                                }`}>
                                <Wifi className="w-3.5 h-3.5" />
                                <span>{signalLevel === 3 ? 'Excellent' : signalLevel === 2 ? 'Good' : signalLevel === 1 ? 'Fair' : 'Poor'}</span>
                            </div>
                            <AudioVisualizer stream={localStream} isMuted={!isMicOn} className="opacity-80" />
                        </div>
                    </div>

                    <div className="md:col-span-2 flex flex-col justify-center space-y-8 pl-4">
                        <div>
                            <h2 className="text-5xl font-display font-medium tracking-tight leading-none mb-2">{meetingDetails?.title || "Meeting"}</h2>
                            <p className="text-white/40 text-lg font-light">
                                Room: {meetingCode}
                            </p>
                        </div>

                        {errorMsg && <div className="text-red-400 text-sm bg-red-500/10 p-3 rounded-lg border border-red-500/20">{errorMsg}</div>}

                        <div className="space-y-4">
                            <input
                                type="text"
                                value={userName}
                                onChange={(e) => setUserName(e.target.value)}
                                placeholder="Your display name"
                                className="w-full bg-transparent border-b border-white/20 py-3 text-xl placeholder:text-white/20 focus:border-white focus:outline-none transition-colors font-display"
                            />

                            {/* Device Selection */}
                            <div className="space-y-3 pt-2">
                                <div className="text-sm text-white/60 font-medium">Device Settings</div>
                                
                                {/* Audio Input */}
                                {devices.audioInputs.length > 0 && (
                                    <div>
                                        <label className="text-xs text-white/40 mb-1 block">Microphone</label>
                                        <select
                                            value={selectedDevices.audioInput}
                                            onChange={async (e) => {
                                                const newDeviceId = e.target.value;
                                                const currentDeviceId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
                                                
                                                // Don't switch if selecting the same device
                                                if (newDeviceId === currentDeviceId) {
                                                    return;
                                                }
                                                
                                                setSelectedDevices(prev => ({ ...prev, audioInput: newDeviceId }));
                                                
                                                // Only switch if we have a stream
                                                if (localStream) {
                                                    try {
                                                        const audioDeviceId = newDeviceId && newDeviceId.trim() !== '' 
                                                            ? newDeviceId 
                                                            : undefined;
                                                        const newAudioStream = await getAudioOnlyStream(audioDeviceId);
                                                        const newAudioTrack = newAudioStream.getAudioTracks()[0];
                                                        
                                                        if (newAudioTrack && localStream) {
                                                            // Remove old audio track
                                                            const oldAudioTracks = localStream.getAudioTracks();
                                                            oldAudioTracks.forEach(oldTrack => {
                                                                localStream.removeTrack(oldTrack);
                                                                oldTrack.stop();
                                                            });
                                                            
                                                            // Add new audio track
                                                            localStream.addTrack(newAudioTrack);
                                                            newAudioTrack.enabled = isMicOn;
                                                            
                                                            // Replace in peer connections if in meeting
                                                            if (view === AppView.MEETING) {
                                                                meetService.replaceAudioTrack(newAudioTrack);
                                                            }
                                                            
                                                            // Stop any video tracks from the new stream (shouldn't be any)
                                                            newAudioStream.getVideoTracks().forEach(t => t.stop());
                                                            
                                                            // Update participants state
                                                            setParticipants(prev => prev.map(p => 
                                                                p.isLocal ? { ...p, audioEnabled: isMicOn } : p
                                                            ));
                                                        }
                                                    } catch (err: any) {
                                                        console.error("Failed to switch audio device:", err);
                                                        setErrorMsg("Failed to switch microphone: " + (err.message || "Unknown error"));
                                                        // Revert selection
                                                        setSelectedDevices(prev => ({ 
                                                            ...prev, 
                                                            audioInput: localStream.getAudioTracks()[0]?.getSettings().deviceId || '' 
                                                        }));
                                                    }
                                                }
                                            }}
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 focus:outline-none transition-colors"
                                        >
                                            {devices.audioInputs.map(device => (
                                                <option key={device.deviceId} value={device.deviceId} className="bg-[#1a1a1a]">
                                                    {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {/* Video Input */}
                                {devices.videoInputs.length > 0 && (
                                    <div>
                                        <label className="text-xs text-white/40 mb-1 block">Camera</label>
                                        <select
                                            value={selectedDevices.videoInput}
                                            onChange={async (e) => {
                                                const newDeviceId = e.target.value;
                                                const currentDeviceId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
                                                
                                                // Don't switch if selecting the same device
                                                if (newDeviceId === currentDeviceId) {
                                                    return;
                                                }
                                                
                                                setSelectedDevices(prev => ({ ...prev, videoInput: newDeviceId }));
                                                
                                                // Only switch if we have a stream
                                                if (localStream) {
                                                    try {
                                                        const videoDeviceId = newDeviceId && newDeviceId.trim() !== '' 
                                                            ? newDeviceId 
                                                            : undefined;
                                                        const newVideoStream = await getVideoOnlyStream(
                                                            videoDeviceId,
                                                            signalLevel <= 1 ? 'low' : 'high'
                                                        );
                                                        const newVideoTrack = newVideoStream.getVideoTracks()[0];
                                                        
                                                        if (newVideoTrack && localStream) {
                                                            // Remove old video track
                                                            const oldVideoTracks = localStream.getVideoTracks();
                                                            oldVideoTracks.forEach(oldTrack => {
                                                                localStream.removeTrack(oldTrack);
                                                                oldTrack.stop();
                                                            });
                                                            
                                                            // Add new video track
                                                            localStream.addTrack(newVideoTrack);
                                                            newVideoTrack.enabled = isCamOn;
                                                            
                                                            // Replace in peer connections if in meeting
                                                            if (view === AppView.MEETING) {
                                                                meetService.replaceVideoTrack(newVideoTrack);
                                                            }
                                                            
                                                            // Stop any audio tracks from the new stream (shouldn't be any)
                                                            newVideoStream.getAudioTracks().forEach(t => t.stop());
                                                            
                                                            // Update video element
                                                            if (localVideoRef.current) {
                                                                localVideoRef.current.srcObject = localStream;
                                                                const playPromise = localVideoRef.current.play();
                                                                if (playPromise !== undefined) {
                                                                    playPromise.catch(e => {
                                                                        if (e.name !== 'AbortError') {
                                                                            console.error("Video play failed:", e);
                                                                        }
                                                                    });
                                                                }
                                                            }
                                                            
                                                            // Update participants state
                                                            setParticipants(prev => prev.map(p => 
                                                                p.isLocal ? { ...p, videoEnabled: isCamOn } : p
                                                            ));
                                                        }
                                                    } catch (err: any) {
                                                        console.error("Failed to switch video device:", err);
                                                        setErrorMsg("Failed to switch camera: " + (err.message || "Unknown error"));
                                                        // Revert selection
                                                        setSelectedDevices(prev => ({ 
                                                            ...prev, 
                                                            videoInput: localStream.getVideoTracks()[0]?.getSettings().deviceId || '' 
                                                        }));
                                                    }
                                                } else if (!localStream) {
                                                    // No stream yet, just refresh
                                                    refreshStream();
                                                }
                                            }}
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 focus:outline-none transition-colors"
                                        >
                                            {devices.videoInputs.map(device => (
                                                <option key={device.deviceId} value={device.deviceId} className="bg-[#1a1a1a]">
                                                    {device.label || `Camera ${device.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {/* Audio Output */}
                                {devices.audioOutputs && devices.audioOutputs.length > 0 && (
                                    <div>
                                        <label className="text-xs text-white/40 mb-1 block">Speaker</label>
                                        <select
                                            value={selectedDevices.audioOutput}
                                            onChange={(e) => {
                                                setSelectedDevices(prev => ({ ...prev, audioOutput: e.target.value }));
                                                // Set audio output device if supported (HTMLAudioElement/HTMLVideoElement)
                                                if (localVideoRef.current && 'setSinkId' in localVideoRef.current) {
                                                    (localVideoRef.current as any).setSinkId(e.target.value).catch(() => {
                                                        console.warn("Failed to set audio output device");
                                                    });
                                                }
                                            }}
                                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500/50 focus:outline-none transition-colors"
                                        >
                                            {devices.audioOutputs.map(device => (
                                                <option key={device.deviceId} value={device.deviceId} className="bg-[#1a1a1a]">
                                                    {device.label || `Speaker ${device.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-col gap-3 pt-4">
                                <button
                                    onClick={handleJoinCall}
                                    disabled={!userName || isLoading}
                                    className="w-full py-4 bg-white text-black font-medium rounded-2xl hover:bg-gray-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                >
                                    {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                                    {isLoading ? 'Connecting...' : 'Join Room'}
                                </button>
                                <button onClick={() => setView(AppView.LANDING)} className="w-full py-4 text-white/50 hover:text-white transition-colors">
                                    Go Back
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // --- WAITING FOR HOST ---
    if (view === AppView.WAITING_FOR_HOST) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center p-4">
                <div className="glass-heavy p-10 rounded-[2rem] text-center space-y-6 max-w-sm w-full border border-white/10">
                    <div className="w-16 h-16 border-t-2 border-blue-500 rounded-full animate-spin mx-auto" />
                    <div>
                        <h2 className="text-xl font-medium">Waiting for Host...</h2>
                        <p className="text-white/40 mt-2">The meeting will start when the host joins.</p>
                    </div>
                    <button onClick={() => window.location.reload()} className="text-white/30 hover:text-white text-sm">Cancel</button>
                </div>
            </div>
        );
    }

    // --- JOINING / WAITING ---
    if (view === AppView.JOINING) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center p-4">
                <div className="glass-heavy p-10 rounded-[2rem] text-center space-y-6 max-w-sm w-full border border-white/10">
                    {connectionStatus === 'denied' ? (
                        <>
                            <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto text-red-500"><X /></div>
                            <h2 className="text-xl font-medium">Access Denied</h2>
                            <button onClick={() => setView(AppView.LANDING)} className="text-white/50 hover:text-white">Exit</button>
                        </>
                    ) : (
                        <>
                            <div className="w-16 h-16 border-t-2 border-white rounded-full animate-spin mx-auto" />
                            <div>
                                <h2 className="text-xl font-medium">Knocking...</h2>
                                <p className="text-white/40 mt-2">Waiting for host to let you in.</p>
                            </div>
                            <button onClick={() => window.location.reload()} className="text-white/30 hover:text-white text-sm">Cancel</button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    // --- MEETING VIEW ---
    return (
        <div className="h-screen w-full bg-[#050505] text-white flex flex-col overflow-hidden relative">

            {/* Error Toast for Meeting View */}
            {errorMsg && (
                <div className="absolute top-24 left-1/2 -translate-x-1/2 z-50 animate-enter pointer-events-none">
                    <div className="pointer-events-auto bg-red-500/20 backdrop-blur-xl border border-red-500/30 text-red-200 px-4 py-2 rounded-full flex items-center gap-2 shadow-xl">
                        <AlertCircle className="w-4 h-4" />
                        <span className="text-sm font-medium">{errorMsg}</span>
                        <button onClick={() => setErrorMsg(null)} className="ml-2 hover:text-white"><X className="w-3 h-3" /></button>
                    </div>
                </div>
            )}

            {joinRequestId && (
                <div className="absolute top-8 left-1/2 -translate-x-1/2 z-50 glass-heavy pl-6 pr-2 py-2 rounded-full flex items-center gap-6 shadow-2xl">
                    <span className="text-sm font-medium">{joinRequestName} <span className="text-white/40 font-normal">knocking</span></span>
                    <div className="flex gap-1">
                        <button onClick={() => { meetService.denyParticipant(joinRequestId!); setJoinRequestId(null); }} className="p-2 hover:bg-white/10 rounded-full text-red-400"><X className="w-4 h-4" /></button>
                        <button onClick={() => { meetService.admitParticipant(joinRequestId!, joinRequestName || 'Guest'); setJoinRequestId(null); setJoinRequestName(null); }} className="p-2 bg-white text-black rounded-full hover:bg-gray-200"><Check className="w-4 h-4" /></button>
                    </div>
                </div>
            )}

            <div className="flex-1 p-4 md:p-6 overflow-hidden flex gap-4 relative">
                {participants.length === 2 ? (
                    // Google Meet style: Remote participant large/centered, local as small overlay
                    <>
                        {/* Remote participant - large and centered */}
                        {participants.filter(p => !p.isLocal).map(p => (
                            <div key={p.id} className="absolute inset-4 md:inset-6 flex items-center justify-center">
                                <ParticipantTile
                                    participant={p}
                                    localVideoRef={undefined}
                                    isHost={meetingDetails?.isHost}
                                    onKick={handleKick}
                                />
                            </div>
                        ))}
                        {/* Local participant - small overlay in bottom-right (Google Meet style) */}
                        {participants.filter(p => p.isLocal).map(p => (
                            <div key={p.id} className="absolute bottom-24 right-6 w-[200px] h-[150px] md:w-[256px] md:h-[192px] z-30 shadow-2xl">
                                <ParticipantTile
                                    participant={p}
                                    localVideoRef={localVideoRef}
                                    isHost={meetingDetails?.isHost}
                                    onKick={handleKick}
                                    isSmallOverlay={true}
                                />
                            </div>
                        ))}
                    </>
                ) : (
                    // Grid layout for 1 or 3+ participants
                <div className={`flex-1 grid gap-4 md:gap-6 transition-all duration-500 ${participants.length <= 1 ? 'grid-cols-1 max-w-5xl mx-auto' :
                        'grid-cols-2 md:grid-cols-3'
                    }`}>
                    {participants.map(p => (
                        <ParticipantTile
                            key={p.id}
                            participant={p}
                            localVideoRef={p.isLocal ? localVideoRef : undefined}
                            isHost={meetingDetails?.isHost}
                            onKick={handleKick}
                        />
                    ))}
                </div>
                )}

                {(isChatOpen || isParticipantsOpen) && (
                    <div className="w-80 glass-heavy rounded-3xl flex flex-col overflow-hidden border border-white/10">
                        <div className="p-5 border-b border-white/5 flex justify-between items-center">
                            <span className="font-medium text-sm tracking-widest uppercase text-white/50">{isChatOpen ? "Chat" : "Participants"}</span>
                            <button onClick={() => { setIsChatOpen(false); setIsParticipantsOpen(false); }} className="text-white/30 hover:text-white"><X className="w-4 h-4" /></button>
                        </div>
                        {isChatOpen ? (
                            <div className="flex-1 flex flex-col">
                                <div className="flex-1 overflow-y-auto p-4 space-y-4" id="chat-messages">
                                    {messages.map(m => {
                                        const date = new Date(m.timestamp);
                                        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                        return (
                                        <div key={m.id} className={`flex flex-col ${m.senderId === 'local' ? 'items-end' : 'items-start'}`}>
                                            <div className={`px-4 py-2 rounded-2xl text-sm max-w-[85%] ${m.senderId === 'local' ? 'bg-white text-black rounded-tr-sm' : 'bg-white/10 text-white rounded-tl-sm'}`}>
                                                {m.text}
                                            </div>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="text-[10px] text-white/40">{m.senderName}</span>
                                                    <span className="text-[10px] text-white/20">{timeStr}</span>
                                        </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                <form onSubmit={sendMessage} className="p-4 border-t border-white/5">
                                    <input
                                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-white/30 transition-colors"
                                        placeholder="Type message..."
                                        value={newMessage}
                                        onChange={e => setNewMessage(e.target.value)}
                                    />
                                </form>
                            </div>
                        ) : (
                            <div className="flex-1 p-4 space-y-2 overflow-y-auto">
                                <div className="text-xs text-white/40 mb-2 font-medium">
                                    {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
                                </div>
                                {participants.map(p => (
                                    <div key={p.id} className="flex items-center justify-between p-3 rounded-xl hover:bg-white/5 transition-colors group">
                                        <div className="flex items-center gap-3 flex-1 min-w-0">
                                            <div className="relative">
                                                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs flex-shrink-0">
                                                    {!p.videoEnabled ? p.name[0]?.toUpperCase() : ''}
                                        </div>
                                                {p.isSpeaking && (
                                                    <div className="absolute -inset-1 rounded-full border-2 border-blue-500 animate-pulse"></div>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium truncate">
                                                    {p.name} {p.isLocal && <span className="text-white/50">(You)</span>}
                                                    {p.isScreenShare && <Monitor className="w-3 h-3 inline ml-1 text-blue-400" />}
                                                </div>
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    {!p.audioEnabled && (
                                                        <span className="text-[10px] text-red-400 flex items-center gap-1">
                                                            <MicOff className="w-2.5 h-2.5" /> Muted
                                                        </span>
                                                    )}
                                                    {!p.videoEnabled && (
                                                        <span className="text-[10px] text-white/40 flex items-center gap-1">
                                                            <VideoOff className="w-2.5 h-2.5" /> Camera off
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex gap-2 text-white/30 items-center flex-shrink-0">
                                            {meetingDetails?.isHost && !p.isLocal && (
                                                <button 
                                                    onClick={() => handleKick(p.id)} 
                                                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-all"
                                                    title="Remove participant"
                                                >
                                                    <Ban className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                            {p.isSpeaking && p.audioEnabled && (
                                                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="h-20 flex items-center justify-center z-20 pointer-events-none">
                <div className="pointer-events-auto bg-[#202124] border border-white/5 rounded-full px-4 md:px-6 py-2.5 md:py-3 shadow-2xl flex items-center gap-1.5 md:gap-2 mb-6">

                    <div className="flex items-center gap-2 pr-4 border-r border-white/10 mr-2">
                        {/* Timer Display */}
                        <div className="text-xs text-white/90 font-mono hidden md:flex items-center gap-2 mr-2 bg-white/5 px-2 py-1 rounded">
                            <Clock className="w-3 h-3 text-white/50" />
                            {elapsedTime}
                        </div>

                        <div className="text-xs text-white/50 font-mono hidden md:block">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        <div className="w-px h-4 bg-white/10 hidden md:block mx-2"></div>
                        <Tooltip text="Copy Code">
                            <button onClick={() => navigator.clipboard.writeText(meetingCode)} className="text-xs font-mono text-white hover:text-white/70 transition-colors flex gap-1">
                                {meetingCode} <Copy className="w-3 h-3 mt-0.5 opacity-50" />
                            </button>
                        </Tooltip>
                        <div className="w-px h-4 bg-white/10 hidden md:block mx-2"></div>
                        <div className="flex items-center gap-1.5 text-xs font-mono text-white/50">
                            <Users className="w-3 h-3" />
                            <span>{participants.length}</span>
                        </div>
                    </div>

                    <Tooltip text={isMicOn ? "Mute" : "Unmute"}>
                        <button onClick={toggleMic} className={`p-3 md:p-4 rounded-full transition-all ${isMicOn ? 'hover:bg-white/10 text-white' : 'bg-red-500 text-white'}`}>
                            {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
                        </button>
                    </Tooltip>

                    <Tooltip text={isCamOn ? "Stop Video" : "Start Video"}>
                        <button onClick={toggleCam} className={`p-3 md:p-4 rounded-full transition-all ${isCamOn ? 'hover:bg-white/10 text-white' : 'bg-red-500 text-white'}`}>
                            {isCamOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                        </button>
                    </Tooltip>

                    <Tooltip text={isScreenSharing ? "Stop Sharing" : "Share Screen"}>
                        <button onClick={toggleScreenShare} className={`p-3 md:p-4 rounded-full transition-all ${isScreenSharing ? 'bg-indigo-500 text-white' : 'hover:bg-white/10 text-white'}`}>
                            {isScreenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
                        </button>
                    </Tooltip>

                    <Tooltip text="End Call">
                        <button onClick={() => window.location.reload()} className="p-3 md:p-4 rounded-full bg-[#ea4335] text-white hover:bg-[#d33b2c] transition-all ml-2">
                            <PhoneOff className="w-5 h-5" />
                        </button>
                    </Tooltip>

                    <div className="w-px h-8 bg-white/10 mx-2"></div>

                    <Tooltip text="Participants">
                        <button onClick={() => { setIsParticipantsOpen(!isParticipantsOpen); setIsChatOpen(false); }} className={`p-3 md:p-4 rounded-full hover:bg-white/10 transition-all ${isParticipantsOpen ? 'text-white bg-white/10' : 'text-white/50'}`}>
                            <Users className="w-5 h-5" />
                        </button>
                    </Tooltip>

                    <Tooltip text="Chat">
                        <button onClick={() => { setIsChatOpen(!isChatOpen); setIsParticipantsOpen(false); }} className={`p-3 md:p-4 rounded-full hover:bg-white/10 transition-all ${isChatOpen ? 'text-white bg-white/10' : 'text-white/50'}`}>
                            <MessageSquare className="w-5 h-5" />
                        </button>
                    </Tooltip>

                </div>
            </div>
        </div>
    );

    function sendMessage(e?: React.FormEvent) {
        e?.preventDefault();
        if (!newMessage.trim()) return;
        const msg: ChatMessage = { id: Date.now().toString(), senderId: 'local', senderName: userName, text: newMessage, timestamp: Date.now() };
        setMessages(p => [...p, msg]);
        meetService.broadcastMessage(msg);
        setNewMessage('');
        
        // Scroll to bottom after sending message
        setTimeout(() => {
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }, 100);
    }

    // Auto-scroll chat to bottom on new messages
    useEffect(() => {
        if (isChatOpen && messages.length > 0) {
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }
    }, [messages, isChatOpen]);
}

interface ParticipantTileProps {
    participant: Participant;
    localVideoRef?: React.RefObject<HTMLVideoElement | null>;
    isHost?: boolean;
    onKick?: (id: string) => void;
    isSmallOverlay?: boolean; // For local participant when 2 people in call
}

const ParticipantTile: React.FC<ParticipantTileProps> = ({ participant, localVideoRef, isHost, onKick, isSmallOverlay = false }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    
    // Helper function to get initials from name
    const getInitials = (name: string): string => {
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name[0]?.toUpperCase() || '?';
    };
    
    useEffect(() => {
        if (!participant.isLocal && participant.stream && videoRef.current && participant.videoEnabled) {
            videoRef.current.srcObject = participant.stream;
            const playPromise = videoRef.current.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => {
                    if (e.name !== 'AbortError') {
                        console.error("Video play failed:", e);
                    }
                });
            }
        } else if (!participant.isLocal && videoRef.current && !participant.videoEnabled) {
            // Clear video stream when video is disabled
            videoRef.current.srcObject = null;
        }
    }, [participant.stream, participant.isLocal, participant.videoEnabled]);

    // Ensure local video stream is attached when in meeting view
    useEffect(() => {
        if (participant.isLocal && participant.stream && localVideoRef?.current && participant.videoEnabled) {
            localVideoRef.current.srcObject = participant.stream;
            const playPromise = localVideoRef.current.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => {
                    if (e.name !== 'AbortError') {
                        console.error("Local video play failed:", e);
                    }
                });
            }
        } else if (participant.isLocal && localVideoRef?.current && !participant.videoEnabled) {
            // Clear video stream when video is disabled
            localVideoRef.current.srcObject = null;
        }
    }, [participant.stream, participant.isLocal, participant.videoEnabled, localVideoRef]);

    return (
        <div className={`relative w-full h-full bg-[#111] overflow-hidden border border-white/5 shadow-2xl group transition-all duration-300 ${isSmallOverlay ? 'rounded-2xl' : 'rounded-[2rem]'}`}>
            {/* Host Kick Button - Top Right Overlay */}
            {isHost && !participant.isLocal && (
                <div className={`absolute ${isSmallOverlay ? 'top-2 right-2' : 'top-4 right-4'} z-30 opacity-0 group-hover:opacity-100 transition-opacity`}>
                    <button
                        onClick={() => onKick && onKick(participant.id)}
                        className={`${isSmallOverlay ? 'p-1.5' : 'p-2'} bg-red-500/20 backdrop-blur text-red-500 rounded-full hover:bg-red-500 hover:text-white transition-all shadow-lg border border-red-500/30`}
                        title="Remove participant"
                    >
                        <Ban className={isSmallOverlay ? 'w-3 h-3' : 'w-4 h-4'} />
                    </button>
                </div>
            )}

            {/* Video element - only shown when video is enabled */}
            {participant.videoEnabled ? (
                participant.isLocal ? (
                <video
                    ref={localVideoRef}
                    autoPlay
                    muted
                    playsInline
                        className={`w-full h-full object-cover ${!participant.isScreenShare ? 'transform scale-x-[-1]' : ''}`}
                />
            ) : (
                    <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                )
            ) : (
                /* Show initials when video is off */
                <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0a]">
                    <div className={`${isSmallOverlay ? 'w-16 h-16 text-2xl' : 'w-32 h-32 text-4xl'} rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center font-display font-medium text-white/90`}>
                        {getInitials(participant.name)}
                    </div>
                </div>
            )}

            <div className={`absolute ${isSmallOverlay ? 'bottom-2 left-2' : 'bottom-4 left-4'} z-20 max-w-[80%] flex items-center gap-2`}>
                <div className="bg-black/40 backdrop-blur-sm px-3 py-1.5 rounded-md">
                    <span className={`${isSmallOverlay ? 'text-[10px]' : 'text-xs'} text-white font-medium truncate block`}>
                        {participant.name}{participant.isLocal ? ' (You)' : ''}
                    </span>
                </div>
                {/* Audio Visualizer on Tile */}
                {!participant.audioEnabled && (
                    <div className="bg-black/40 backdrop-blur-sm p-1.5 rounded-md">
                        <MicOff className={isSmallOverlay ? 'w-2.5 h-2.5 text-white' : 'w-3 h-3 text-white'} />
                    </div>
                )}
            </div>

            {participant.isSpeaking && (
                <div className={`absolute inset-0 border-[4px] border-blue-500 ${isSmallOverlay ? 'rounded-2xl' : 'rounded-[2rem]'} animate-pulse shadow-[0_0_30px_rgba(59,130,246,0.4)] pointer-events-none z-10 transition-opacity duration-300`} />
            )}
        </div>
    );
};