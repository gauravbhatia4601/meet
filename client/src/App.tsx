import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import MeetingRoom from './pages/MeetingRoom';
import AboutPage from './pages/AboutPage';

export default function App() {
  return (
    <>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:roomId" element={<MeetingRoom />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </>
  );
}