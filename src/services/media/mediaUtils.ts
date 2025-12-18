export const getMediaStream = async (
  audioDeviceId?: string,
  videoDeviceId?: string,
  quality: 'high' | 'low' = 'high'
): Promise<MediaStream> => {
  const videoConstraints = quality === 'high' 
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };

  // Build constraints - only include deviceId if it's provided and not empty
  const constraints: MediaStreamConstraints = {
    audio: audioDeviceId && audioDeviceId.trim() !== ''
      ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: videoDeviceId && videoDeviceId.trim() !== ''
      ? { deviceId: { exact: videoDeviceId }, ...videoConstraints }
      : { ...videoConstraints, facingMode: 'user' },
  };
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Validate that we got the tracks we requested
    if (audioDeviceId && audioDeviceId.trim() !== '') {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.getSettings().deviceId !== audioDeviceId) {
        console.warn("Requested audio device not matched, got:", audioTrack.getSettings().deviceId);
      }
    }
    
    if (videoDeviceId && videoDeviceId.trim() !== '') {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.getSettings().deviceId !== videoDeviceId) {
        console.warn("Requested video device not matched, got:", videoTrack.getSettings().deviceId);
      }
    }
    
    return stream;
  } catch (error: any) {
    console.error("getMediaStream error:", error);
    throw error;
  }
};

export const applyVideoConstraints = async (stream: MediaStream, quality: 'high' | 'low') => {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    const constraints = quality === 'high' 
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };

    try {
      await videoTrack.applyConstraints(constraints);
    } catch (error) {
      console.warn("Could not apply video constraints:", error);
    }
};

export const getDisplayMediaStream = async (): Promise<MediaStream> => {
    // @ts-ignore - getDisplayMedia exists
    return await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as any,
        audio: true
    });
}

export const getConnectedDevices = async (requestPermissions: boolean = false): Promise<{
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
}> => {
  try {
    // Only request permissions if explicitly requested (e.g., when entering lobby)
    if (requestPermissions) {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        tempStream.getTracks().forEach(track => track.stop());
      } catch (err) {
        // Permission denied or device unavailable - continue anyway
        console.warn("Permission request failed, continuing with limited device info:", err);
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    
    // Filter out iPhone cameras on macOS (they appear as videoinput but don't work well)
    const filteredVideoInputs = devices.filter((d) => {
      if (d.kind !== 'videoinput') return false;
      
      // Skip if deviceId is empty (invalid device)
      if (!d.deviceId || d.deviceId === 'default') {
        return false;
      }
      
      // Exclude iPhone cameras - they typically have labels containing "iPhone" or specific device IDs
      const label = d.label.toLowerCase();
      const deviceId = d.deviceId.toLowerCase();
      
      // Exclude iPhone, iPad cameras (iOS devices used as cameras on macOS)
      // Also exclude Continuity Camera which is iPhone used as webcam
      if (label.includes('iphone') || label.includes('ipad') || 
          label.includes('continuity') ||
          deviceId.includes('iphone') || deviceId.includes('ipad')) {
        return false;
      }
      
      return true;
    });
    
    // Filter audio inputs - also exclude iPhone microphones
    const filteredAudioInputs = devices.filter((d) => {
      if (d.kind !== 'audioinput') return false;
      // Skip if deviceId is empty (invalid device)
      if (!d.deviceId || d.deviceId === 'default') {
        return false;
      }
      
      // Exclude iPhone/iPad microphones (iOS devices used as audio inputs on macOS)
      const label = d.label.toLowerCase();
      const deviceId = d.deviceId.toLowerCase();
      
      if (label.includes('iphone') || label.includes('ipad') || 
          label.includes('continuity') ||
          deviceId.includes('iphone') || deviceId.includes('ipad')) {
        return false;
      }
      
      return true;
    });
    
    // Filter audio outputs
    const filteredAudioOutputs = devices.filter((d) => {
      if (d.kind !== 'audiooutput') return false;
      if (!d.deviceId || d.deviceId === 'default') {
        return false;
      }
      return true;
    });
    
    return {
      audioInputs: filteredAudioInputs,
      audioOutputs: filteredAudioOutputs,
      videoInputs: filteredVideoInputs,
    };
  } catch (error) {
    console.error("Error enumerating devices:", error);
    return {
      audioInputs: [],
      audioOutputs: [],
      videoInputs: [],
    };
  }
};

export const stopStream = (stream: MediaStream | null) => {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
};

export const getAudioOnlyStream = async (
  audioDeviceId?: string
): Promise<MediaStream> => {
  const constraints: MediaStreamConstraints = {
    audio: audioDeviceId && audioDeviceId.trim() !== ''
      ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  };
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Validate audio device
    if (audioDeviceId && audioDeviceId.trim() !== '') {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && audioTrack.getSettings().deviceId !== audioDeviceId) {
        console.warn("Requested audio device not matched, got:", audioTrack.getSettings().deviceId);
      }
    }
    
    return stream;
  } catch (error: any) {
    console.error("getAudioOnlyStream error:", error);
    throw error;
  }
};

export const getVideoOnlyStream = async (
  videoDeviceId?: string,
  quality: 'high' | 'low' = 'high'
): Promise<MediaStream> => {
  const videoConstraints = quality === 'high' 
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } };

  const constraints: MediaStreamConstraints = {
    audio: false,
    video: videoDeviceId && videoDeviceId.trim() !== ''
      ? { deviceId: { exact: videoDeviceId }, ...videoConstraints }
      : { ...videoConstraints, facingMode: 'user' },
  };
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Validate video device
    if (videoDeviceId && videoDeviceId.trim() !== '') {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.getSettings().deviceId !== videoDeviceId) {
        console.warn("Requested video device not matched, got:", videoTrack.getSettings().deviceId);
      }
    }
    
    return stream;
  } catch (error: any) {
    console.error("getVideoOnlyStream error:", error);
    throw error;
  }
};

export const validateStream = (stream: MediaStream | null): boolean => {
  if (!stream) return false;
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.some(track => track.readyState === 'live');
};

export const requestDevicePermissions = async (): Promise<{ audio: boolean; video: boolean }> => {
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStream.getTracks().forEach(track => track.stop());
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoStream.getTracks().forEach(track => track.stop());
    return { audio: true, video: true };
  } catch (err: any) {
    const audio = err.name !== 'NotAllowedError' && err.name !== 'NotFoundError';
    const video = err.name !== 'NotAllowedError' && err.name !== 'NotFoundError';
    return { audio, video };
  }
};

